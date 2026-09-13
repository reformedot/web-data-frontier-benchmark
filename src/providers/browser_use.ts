import { chromium, type Browser } from "playwright-core";
import type { Provider } from "../types.js";
import { requireEnv } from "./_shared.js";

const API_BASE_URL = "https://api.browser-use.com/api/v4";
const TEARDOWN_TIMEOUT_MS = 5_000;
/** Server-side backstop in minutes: above the runner's per-attempt timeout, far below the 60-minute default. */
const SESSION_TIMEOUT_MINUTES = 5;

type RequestFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ConnectFunction = (cdpUrl: string) => Promise<Browser>;

interface BrowserSession {
  id: string;
  cdpUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBrowserSession(value: unknown): BrowserSession {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Browser Use returned an invalid create-browser response");
  }
  if (typeof value.cdpUrl !== "string" || value.cdpUrl === "") {
    throw new Error("Browser Use created a browser without a CDP URL");
  }
  return { id: value.id, cdpUrl: value.cdpUrl };
}

async function requestJSON(request: RequestFunction, apiKey: string, path: string, init: RequestInit): Promise<unknown> {
  const response = await request(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
      ...init.headers
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Browser Use request failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return response.json();
}

async function stopBrowser(request: RequestFunction, apiKey: string, sessionID: string): Promise<void> {
  await requestJSON(request, apiKey, `/browsers/${sessionID}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "stop" }),
    signal: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS)
  });
}

export function createBrowserUseProvider(
  request: RequestFunction = globalThis.fetch,
  connect: ConnectFunction = (cdpUrl) => chromium.connectOverCDP(cdpUrl)
): Provider {
  return {
    name: "browser_use",
    envKeys: ["BROWSER_USE_API_KEY"],
    async fetch(url, { timeoutMs, signal }) {
      const apiKey = requireEnv("BROWSER_USE_API_KEY");
      let session: BrowserSession | undefined;
      let browser: Browser | undefined;

      try {
        session = parseBrowserSession(
          await requestJSON(request, apiKey, "/browsers", {
            method: "POST",
            /** WHY: proxy settings sit at the top level here; `browserSettings` is the agent-run shape and is rejected. */
            body: JSON.stringify({ proxyCountryCode: "us", timeout: SESSION_TIMEOUT_MINUTES }),
            signal
          })
        );

        browser = await connect(session.cdpUrl);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = context.pages()[0] ?? (await context.newPage());

        const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
        if (!response) throw new Error("Browser Use navigation returned no response");
        return { body: await page.content(), statusCode: response.status() };
      } finally {
        /** WHY: detached — the runner times `fetch`, so teardown must not add latency or fail a verified result. */
        void browser?.close().catch(() => {});
        if (session !== undefined) {
          const sessionID = session.id;
          void stopBrowser(request, apiKey, sessionID).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`browser_use: failed to stop session ${sessionID}, billing until its timeout — ${reason}`);
          });
        }
      }
    }
  };
}

/** WHY: a standalone cloud browser driven over CDP — stealth and CAPTCHA solving are on by default and need no agent run. */
export const browserUse = createBrowserUseProvider();
