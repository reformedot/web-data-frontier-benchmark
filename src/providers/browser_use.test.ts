import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright-core";
import { validateResponse } from "../check.js";
import { createBrowserUseProvider } from "./browser_use.js";
import { getProvider } from "./index.js";

interface RecordedRequest {
  init?: RequestInit;
  url: string;
}

interface FakeBrowser {
  browser: Browser;
  closed: () => boolean;
  gotoOptions: () => unknown;
  visited: () => string[];
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** A CDP browser that serves one fixed page, recording what the adapter asked it to do. */
function fakeBrowser(html: string, statusCode = 200, onClose: () => Promise<void> = async () => {}): FakeBrowser {
  const visited: string[] = [];
  let closed = false;
  let gotoOptions: unknown;

  const page = {
    content: async () => html,
    goto: async (url: string, options: unknown) => {
      visited.push(url);
      gotoOptions = options;
      return { status: () => statusCode };
    }
  };
  const context = { newPage: async () => page, pages: () => [page] };
  const browser = {
    close: async () => {
      closed = true;
      await onClose();
    },
    contexts: () => [context],
    newContext: async () => context
  };

  return {
    browser: browser as unknown as Browser,
    closed: () => closed,
    gotoOptions: () => gotoOptions,
    visited: () => visited
  };
}

function providerWithResponses(responses: Response[], requests: RecordedRequest[], browser: Browser) {
  return createBrowserUseProvider(
    async (input, init) => {
      requests.push({ url: String(input), init });
      const nextResponse = responses.shift();
      if (!nextResponse) throw new Error("Unexpected Browser Use request");
      return nextResponse;
    },
    async () => browser
  );
}

const SESSION = { id: "session-1", cdpUrl: "wss://cdp.browser-use.com/session-1" };
/** The suite's own per-attempt timeout (`src/tests.const.ts`), so the derived session cap is exercised as configured. */
const BENCHMARK_TIMEOUT_MS = 90_000;

function fetchOptions(timeoutMs = BENCHMARK_TIMEOUT_MS) {
  return { timeoutMs, signal: new AbortController().signal };
}

test("registers Browser Use behind its API key", () => {
  assert.deepEqual(getProvider("browser_use")?.envKeys, ["BROWSER_USE_API_KEY"]);
});

test("creates a standalone US-proxied browser and returns the page source", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const requests: RecordedRequest[] = [];
  const fake = fakeBrowser("<html><body>Example Domain</body></html>");
  const provider = providerWithResponses([response(SESSION), response({ status: "stopped" })], requests, fake.browser);

  const result = await provider.fetch("https://example.com", fetchOptions());

  assert.deepEqual(result, { body: "<html><body>Example Domain</body></html>", statusCode: 200 });
  assert.deepEqual(fake.visited(), ["https://example.com"]);
  assert.deepEqual(fake.gotoOptions(), { timeout: BENCHMARK_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  assert.deepEqual(
    requests.map(({ url, init }) => ({ url, method: init?.method })),
    [
      { url: "https://api.browser-use.com/api/v4/browsers", method: "POST" },
      { url: "https://api.browser-use.com/api/v4/browsers/session-1", method: "PATCH" }
    ]
  );
  // Proxy settings are top-level on /browsers; the agent-run `browserSettings` wrapper is rejected there.
  // 90s of attempt timeout rounds up to a 2-minute session cap, not the API's 60-minute default.
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { proxyCountryCode: "us", timeout: 2 });
  assert.deepEqual(requests[0].init?.headers, {
    "Content-Type": "application/json",
    "X-Browser-Use-API-Key": "test-key"
  });
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { action: "stop" });
});

test("passes a source-only marker that rendered text would drop", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  // `kroger` and `bing` score on tokens that never appear as visible text; raw DOM carries both.
  const html = '<html><head><title>openai - Search</title></head><body data-x=\'"upc":"0001111041700"\'>Milk</body></html>';
  const fake = fakeBrowser(html);
  const provider = providerWithResponses([response(SESSION), response({ status: "stopped" })], [], fake.browser);

  const { body, statusCode } = await provider.fetch("https://www.kroger.com/p/x/0001111041700", fetchOptions());

  assert.equal(validateResponse(body, statusCode, 1, '"upc":"0001111041700"').success, true);
  assert.equal(validateResponse(body, statusCode, 1, "openai - Search").success, true);
});

test("reports the upstream status instead of assuming success", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const fake = fakeBrowser("<html>Access Denied</html>", 403);
  const provider = providerWithResponses([response(SESSION), response({ status: "stopped" })], [], fake.browser);

  const { body, statusCode } = await provider.fetch("https://example.com", fetchOptions());

  assert.equal(statusCode, 403);
  assert.deepEqual(validateResponse(body, statusCode, 1, "Access Denied"), {
    success: false,
    latencyMs: 1,
    errorMessage: "Status 403"
  });
});

test("stops the browser session after a navigation failure", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const requests: RecordedRequest[] = [];
  const fake = fakeBrowser("");
  const failing = { ...fake.browser, contexts: () => [{ pages: () => [{ goto: async () => null }] }] };
  const provider = providerWithResponses(
    [response(SESSION), response({ status: "stopped" })],
    requests,
    failing as unknown as Browser
  );

  await assert.rejects(provider.fetch("https://example.com", fetchOptions()), /navigation returned no response/);
  assert.equal(requests.at(-1)?.url, "https://api.browser-use.com/api/v4/browsers/session-1");
});

test("surfaces a create-browser failure without a teardown call", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const requests: RecordedRequest[] = [];
  const fake = fakeBrowser("");
  const provider = providerWithResponses([response({ detail: "out of credits" }, 402)], requests, fake.browser);

  await assert.rejects(provider.fetch("https://example.com", fetchOptions()), /failed with status 402: .*out of credits/);
  assert.deepEqual(
    requests.map(({ url }) => url),
    ["https://api.browser-use.com/api/v4/browsers"]
  );
});

test("rejects a browser created without a CDP URL", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const fake = fakeBrowser("");
  const provider = providerWithResponses(
    [response({ id: "session-2", cdpUrl: null }), response({ status: "stopped" })],
    [],
    fake.browser
  );

  await assert.rejects(provider.fetch("https://example.com", fetchOptions()), /created a browser without a CDP URL/);
});

test("logs a failed teardown rather than dropping a billable session", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  const fake = fakeBrowser("<html>ok</html>");
  const provider = providerWithResponses(
    [response(SESSION), response({ detail: "teardown unavailable" }, 500)],
    [],
    fake.browser
  );

  try {
    const result = await provider.fetch("https://example.com", fetchOptions());
    assert.deepEqual(result, { body: "<html>ok</html>", statusCode: 200 });
    // The teardown is detached, so give its rejection a turn to reach the handler.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to stop session session-1, billing until its timeout/);
});

test("returns without waiting for teardown", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  let finishTeardown = (): void => {};
  const teardown = new Promise<Response>((resolve) => {
    finishTeardown = () => resolve(response({ status: "stopped" }));
  });
  const fake = fakeBrowser("<html>ok</html>");
  const provider = createBrowserUseProvider(async (input) => {
    if (String(input).endsWith("/browsers")) return response(SESSION);
    return teardown;
  }, async () => fake.browser);

  // Resolves only because the stop PATCH is detached — awaiting it would deadlock here.
  const result = await provider.fetch("https://example.com", fetchOptions());

  assert.deepEqual(result, { body: "<html>ok</html>", statusCode: 200 });
  assert.equal(fake.closed(), true);
  finishTeardown();
  await teardown;
});

test("caps the session just past the attempt timeout, within the API's range", async () => {
  process.env.BROWSER_USE_API_KEY = "test-key";
  const sessionTimeouts = async (timeoutMs: number): Promise<number> => {
    const requests: RecordedRequest[] = [];
    const fake = fakeBrowser("<html>ok</html>");
    const provider = providerWithResponses([response(SESSION), response({ status: "stopped" })], requests, fake.browser);
    await provider.fetch("https://example.com", fetchOptions(timeoutMs));
    return JSON.parse(String(requests[0].init?.body)).timeout;
  };

  // A sub-minute attempt still has to ask for the API's 1-minute floor rather than 0.
  assert.equal(await sessionTimeouts(30_000), 1);
  assert.equal(await sessionTimeouts(BENCHMARK_TIMEOUT_MS), 2);
  assert.equal(await sessionTimeouts(600_000), 10);
  // And a timeout past the 240-minute ceiling clamps instead of being rejected as out of range.
  assert.equal(await sessionTimeouts(20_000_000), 240);
});
