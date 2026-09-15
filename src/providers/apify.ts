import axios from "axios";
import type { Provider } from "../types.js";
import { httpErrorMessage, lazy, requireEnv } from "./_shared.js";

const client = lazy(() =>
  axios.create({
    // Web Fetch runs in Standby mode, so a request to the Actor's own hostname returns the result directly
    baseURL: "https://web-fetch.apify.actor",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireEnv("APIFY_TOKEN")}`
    }
  })
);

/** Apify Web Fetch Actor — every fetch goes through Apify Proxy's Unblocker group. https://apify.com/apify/web-fetch */
export const apify: Provider = {
  name: "apify",
  envKeys: ["APIFY_TOKEN"],
  async fetch(url, { timeoutMs, signal }) {
    try {
      const response = await client().request<string>({
        url: "/",
        method: "POST",
        // The Actor exposes no stealth switch: Unblocker is always on and escalates to a real browser when a
        // site needs it. `raw` + `unwrap` return the original body verbatim with the target's own status code.
        data: { url, formats: ["raw"], unwrap: true },
        responseType: "text",
        signal,
        timeout: timeoutMs
      });

      return { body: typeof response.data === "string" ? response.data : "", statusCode: response.status };
    } catch (e) {
      throw new Error(httpErrorMessage("Apify", e));
    }
  }
};
