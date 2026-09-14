import { chromium, type Browser } from "playwright-core";
import type { Provider } from "../types.js";
import { requireEnv } from "./_shared.js";

const API_BASE_URL = "https://api.browser-use.com/api/v4";
const TEARDOWN_TIMEOUT_MS = 5_000;
const MIN_SESSION_TIMEOUT_MINUTES = 1;
const MAX_SESSION_TIMEOUT_MINUTES = 240;

/**
 * Server-side backstop for a browser that outlives its teardown, in whole minutes as the API takes it.
 * Rounding the attempt timeout up keeps it just past the runner's own deadline — at the default 90s that
 * is 2 minutes, against an API default of 60 — and it tracks a `--timeout` override instead of drifting.
 */
function sessionTimeoutMinutes(timeoutMs: number): number {
  const minutes = Math.ceil(timeoutMs / 60_000);
  return Math.min(Math.max(minutes, MIN_SESSION_TIMEOUT_MINUTES), MAX_SESSION_TIMEOUT_MINUTES);
}

type RequestFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ConnectFunction = (cdpUrl: string, timeoutMs: number) => Promise<Browser>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * WHY: read before the CDP URL is validated. A create response carrying an id but no `cdpUrl` has
 * already provisioned a billable browser, so the id has to be in hand before anything can throw.
 */
function parseSessionID(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    throw new Error("Browser Use returned an invalid create-browser response");
  }
  return value.id;
}

function parseCdpUrl(value: unknown): string {
  if (!isRecord(value) || typeof value.cdpUrl !== "string" || value.cdpUrl === "") {
    throw new Error("Browser Use created a browser without a CDP URL");
  }
  return value.cdpUrl;
}

/**
 * WHY: `makeExecutor` aborts its signal at the deadline but then just awaits `fetch`, so the provider
 * is the only thing enforcing the per-attempt limit. This adapter spends its budget over four steps,
 * so each one reads what is left of a single deadline rather than starting a fresh `timeoutMs` — a
 * navigation that finishes past the deadline has to fail, not score as a success with inflated latency.
 */
function remainingBudget(expiresAt: number, signal: AbortSignal): number {
  if (signal.aborted) throw new Error("Browser Use attempt was aborted by the runner");
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) throw new Error("Browser Use attempt exceeded its timeout");
  return remainingMs;
}

/** WHY: `page.content()` accepts no timeout of its own, so the deadline has to be imposed around it. */
async function withinBudget<T>(work: Promise<T>, remainingMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Browser Use attempt exceeded its timeout")), remainingMs);
  });
  /** WHY: once the deadline wins the race nothing awaits `work` — claim its rejection so it stays handled. */
  void work.catch(() => {});

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
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
  connect: ConnectFunction = (cdpUrl, timeoutMs) => chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs })
): Provider {
  return {
    name: "browser_use",
    envKeys: ["BROWSER_USE_API_KEY"],
    async fetch(url, { timeoutMs, signal }) {
      const apiKey = requireEnv("BROWSER_USE_API_KEY");
      const expiresAt = Date.now() + timeoutMs;
      let sessionID: string | undefined;
      let browser: Browser | undefined;

      try {
        const created = await requestJSON(request, apiKey, "/browsers", {
          method: "POST",
          /** WHY: proxy settings sit at the top level here; `browserSettings` is the agent-run shape and is rejected. */
          body: JSON.stringify({ proxyCountryCode: "us", timeout: sessionTimeoutMinutes(timeoutMs) }),
          signal
        });
        sessionID = parseSessionID(created);

        browser = await connect(parseCdpUrl(created), remainingBudget(expiresAt, signal));
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = context.pages()[0] ?? (await context.newPage());

        const response = await page.goto(url, {
          timeout: remainingBudget(expiresAt, signal),
          waitUntil: "domcontentloaded"
        });
        if (!response) throw new Error("Browser Use navigation returned no response");
        const body = await withinBudget(page.content(), remainingBudget(expiresAt, signal));
        return { body, statusCode: response.status() };
      } finally {
        /** WHY: detached — the runner times `fetch`, so teardown must not add latency or fail a verified result. */
        void browser?.close().catch(() => {});
        if (sessionID !== undefined) {
          const stopping = sessionID;
          void stopBrowser(request, apiKey, stopping).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`browser_use: failed to stop session ${stopping}, billing until its timeout — ${reason}`);
          });
        }
      }
    }
  };
}

/** WHY: a standalone cloud browser driven over CDP — stealth and CAPTCHA solving are on by default and need no agent run. */
export const browserUse = createBrowserUseProvider();
