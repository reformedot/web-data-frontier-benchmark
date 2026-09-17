import axios from "axios";
import puppeteer, { type Browser } from "puppeteer-core";
import type { Provider } from "../types.js";
import { httpErrorMessage, lazy, requireEnv } from "./_shared.js";

const API_BASE = "https://api.browser-use.com/api/v3";

/** Proxy egress for the session, where "none" disables the managed proxy that some Akamai targets reject. */
const PROXY_COUNTRY = process.env.BROWSER_USE_PROXY_COUNTRY ?? "us";
const proxyCountryCode = PROXY_COUNTRY === "none" ? null : PROXY_COUNTRY;

/** Session lifetime cap in minutes, which only reaps a session whose stop call did not land. */
const SESSION_TIMEOUT_MINUTES = 5;

/** Browser Use reports its CAPTCHA solver through these browser-level CDP events, which arrive on the connection. */
const CAPTCHA_EVENTS = { started: "BrowserUse.captchaSolverStarted", finished: "BrowserUse.captchaSolverFinished" } as const;

/** Bounded settle after load, which is what lets the CAPTCHA solver start on a challenge served as HTTP 200. */
const SETTLE_MS = 8_000;

/** Cap on waiting for a challenge to clear, since an interstitial re-navigates but a hard block never does. */
const CHALLENGE_SETTLE_MS = 20_000;

/** Waits after a solve for the navigation that clears the challenge, because a reported success can mislead. */
const POST_SOLVE_NAV_WAIT_MS = 30_000;

/** Slack at the end of the budget to read the HTML, because a mid-read teardown reports a detached frame. */
const READ_MARGIN_MS = 6_000;

/** Session creation is retried on 429 so queue pressure to reach the starting line is not scored as a block. */
const CREATE_RETRIES = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const apiKey = lazy(() => requireEnv("BROWSER_USE_API_KEY"));

const api = lazy(() =>
  axios.create({
    baseURL: API_BASE,
    headers: { "X-Browser-Use-API-Key": apiKey(), "Content-Type": "application/json" }
  })
);

interface CreateSessionResponse {
  id: string;
  cdpUrl: string | null;
}

interface Session {
  id: string;
  browser: Browser;
}

/** Sessions started but not yet stopped, used only to clean up on interrupt. */
const liveSessions = new Map<string, Browser>();
let cleanupRegistered = false;

/** Starts a cloud browser and attaches over CDP, reading the websocket from the HTTPS DevTools endpoint. */
async function createSession(): Promise<CreateSessionResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await api().post<CreateSessionResponse>("/browsers", {
        timeout: SESSION_TIMEOUT_MINUTES,
        proxyCountryCode
      });
      return data;
    } catch (e) {
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status !== 429 || attempt >= CREATE_RETRIES) throw e;
      await sleep(2_000 * (attempt + 1));
    }
  }
}

async function startSession(): Promise<Session> {
  const data = await createSession();
  if (!data.cdpUrl) throw new Error("Browser Use session started without a cdpUrl");

  try {
    const version = await axios.get<{ webSocketDebuggerUrl?: string }>(`${data.cdpUrl}/json/version`, { timeout: 30_000 });
    const browserWSEndpoint = version.data.webSocketDebuggerUrl;
    if (!browserWSEndpoint) throw new Error("CDP endpoint did not advertise a webSocketDebuggerUrl");

    // A viewport override would replace the randomised screen dimensions the session sets for fingerprinting.
    const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
    liveSessions.set(data.id, browser);
    registerCleanup();
    return { id: data.id, browser };
  } catch (e) {
    await stopSession(data.id);
    throw e;
  }
}

/** Normalises non-Error throws from Puppeteer and CDP, which the shared formatter renders as "[object Object]". */
function describeError(e: unknown): unknown {
  if (e instanceof Error || axios.isAxiosError(e)) return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const detail = o.message ?? o.error ?? o.data;
    return new Error(typeof detail === "string" ? detail : JSON.stringify(e).slice(0, 200));
  }
  return new Error(String(e));
}

/** Ends the remote session, which stops billing and refunds the unused portion of the reserved time. */
async function stopSession(id: string, browser?: Browser): Promise<void> {
  liveSessions.delete(id);
  try {
    browser?.disconnect();
  } catch {
    // Already gone.
  }
  try {
    await api().patch(`/browsers/${id}`, { action: "stop" });
  } catch {
    // Best effort: SESSION_TIMEOUT_MINUTES reaps the session if the stop call fails.
  }
}

/** Ctrl-C backstop so an interrupted run does not leave in-flight sessions billing. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const pending = [...liveSessions.entries()].map(([id, browser]) => stopSession(id, browser));
      void Promise.all(pending).finally(() => process.exit(130));
    });
  }
}

/** Browser Use cloud browsers, where each request gets its own session and a fresh proxy exit IP. */
export const browserUse: Provider = {
  name: "browser_use",
  envKeys: ["BROWSER_USE_API_KEY"],
  async fetch(url, { timeoutMs, signal }) {
    // Timed from entry, so session startup counts against the same budget every other provider gets.
    const deadline = Date.now() + timeoutMs - READ_MARGIN_MS;
    let session: Session;
    try {
      session = await startSession();
    } catch (e) {
      throw new Error(httpErrorMessage("Browser Use", describeError(e)));
    }

    const onAbort = (): void => {
      void stopSession(session.id, session.browser);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const page = await session.browser.newPage();

      // A solved challenge re-navigates, so the last document response reflects what the page finally served.
      let documentStatus: number | undefined;
      let navsSinceSolve = 0;
      let navCount = 0;
      page.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          documentStatus = response.status();
          navsSinceSolve++;
          navCount++;
        }
      });

      // Only one page exists in this browser, so every solver event here belongs to our navigation.
      let solving = false;
      let solverRan = false;
      let lastSolveEnd = 0;
      const connection = (await page.createCDPSession()).connection();
      const onSolveStart = (): void => {
        solving = true;
        solverRan = true;
      };
      const onSolveFinish = (): void => {
        solving = false;
        lastSolveEnd = Date.now();
        navsSinceSolve = 0;
      };
      connection?.on(CAPTCHA_EVENTS.started as never, onSolveStart as never);
      connection?.on(CAPTCHA_EVENTS.finished as never, onSolveFinish as never);

      const response = await page.goto(url, { waitUntil: "load", timeout: Math.max(1_000, deadline - Date.now()) });
      if (documentStatus === undefined) documentStatus = response?.status();

      // PerimeterX serves its challenge with HTTP 200, so the solver needs a settle window to start at all.
      await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});

      // The only wait beyond navigation is the CAPTCHA solver and the navigation that clears the challenge.
      const challengeCap = Math.min(deadline, Date.now() + CHALLENGE_SETTLE_MS);
      let seenNavs = navCount;
      while (Date.now() < deadline) {
        if (solving) {
          await sleep(500);
          continue;
        }
        const awaitingSwap = solverRan && navsSinceSolve === 0 && Date.now() - lastSolveEnd < POST_SOLVE_NAV_WAIT_MS;
        if (awaitingSwap) {
          await sleep(500);
          continue;
        }
        // An interstitial re-navigates to the real page, so settle again and re-check until the frame is still.
        if (navCount !== seenNavs && Date.now() < challengeCap) {
          seenNavs = navCount;
          await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});
          continue;
        }
        break;
      }

      // A challenge re-navigating as we read detaches the frame, and the status we already have still stands.
      const body = await page.content().catch(() => "");
      return { body, statusCode: documentStatus ?? 0 };
    } catch (e) {
      throw new Error(httpErrorMessage("Browser Use", describeError(e)));
    } finally {
      signal.removeEventListener("abort", onAbort);
      await stopSession(session.id, session.browser);
    }
  }
};
