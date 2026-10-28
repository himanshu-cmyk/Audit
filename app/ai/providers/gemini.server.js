// Google Gemini provider using the REST generateContent endpoint with JSON output.
// Docs: https://ai.google.dev/api/generate-content
//       https://ai.google.dev/gemini-api/docs/troubleshooting (retry only 408/429/5xx)
// The key is sent in the x-goog-api-key header (never in the URL, which may be logged).
// No tools / function calling are enabled: the model can only return text.

import { aiError } from "../errors.server";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_RETRY_DELAY_MS = 8000; // longer server-requested waits are treated as quota exhaustion

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayFrom(body) {
  const details = body?.error?.details;
  if (!Array.isArray(details)) return null;
  const info = details.find((d) => typeof d?.["@type"] === "string" && d["@type"].endsWith("RetryInfo"));
  const m = typeof info?.retryDelay === "string" ? info.retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : null;
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export function createGeminiProvider({ apiKey, model, timeoutMs = 20000, maxRetries = 2, fetchImpl = fetch, sleep = defaultSleep }) {
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent`;

  async function generateJson({ system, prompt, schema, maxOutputTokens = 1024 }) {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        if (attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
          continue;
        }
        throw aiError(timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE", { retryable: true });
      }

      if (!res.ok) {
        let errBody = null;
        try {
          errBody = await res.json();
        } catch {
          // ignore unparsable error bodies
        }
        const status = res.status;
        if (status === 429) {
          const wait = retryDelayFrom(errBody);
          const quota = /quota/i.test(errBody?.error?.message || "") || (wait !== null && wait > MAX_RETRY_DELAY_MS);
          if (!quota && attempt < maxRetries) {
            await sleep(Math.min(wait ?? 1000 * 2 ** attempt, MAX_RETRY_DELAY_MS) + Math.floor(Math.random() * 250));
            continue;
          }
          throw aiError(quota ? "AI_QUOTA" : "AI_RATE_LIMITED", { retryable: true });
        }
        if ((status === 408 || status >= 500) && attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
          continue;
        }
        if (status === 401 || status === 403) throw aiError("AI_AUTH");
        if (status === 400 || status === 404) throw aiError("AI_BAD_REQUEST");
        throw aiError(status === 504 || status === 408 ? "AI_TIMEOUT" : "AI_UNAVAILABLE", { retryable: true });
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw aiError("AI_INVALID_RESPONSE");
      }
      if (data?.promptFeedback?.blockReason) throw aiError("AI_BLOCKED");
      const candidate = data?.candidates?.[0];
      if (!candidate) throw aiError("AI_INVALID_RESPONSE");
      if (candidate.finishReason && candidate.finishReason !== "STOP") {
        throw aiError(candidate.finishReason === "MAX_TOKENS" ? "AI_INVALID_RESPONSE" : "AI_BLOCKED");
      }
      const text = (candidate.content?.parts || []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
      try {
        return JSON.parse(text);
      } catch {
        throw aiError("AI_INVALID_RESPONSE");
      }
    }
  }

  return { name: "gemini", model, generateJson };
}
