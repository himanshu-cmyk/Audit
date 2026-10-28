// AI configuration, read only on the server. The API key never leaves this
// module except as a request header to the provider; aiStatus() is safe to send
// to the browser because it contains no secret.

// There is deliberately no default model: model names are retired over time, so
// the operator sets GEMINI_MODEL after checking current availability (see README).

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/;

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readAiConfig(env = process.env) {
  const provider = (env.AI_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "none")).toLowerCase();
  const model = env.GEMINI_MODEL || "";
  return {
    provider,
    apiKey: env.GEMINI_API_KEY || "",
    model,
    modelValid: MODEL_RE.test(model),
    timeoutMs: clampInt(env.AI_TIMEOUT_MS, 3000, 60000, 20000),
    maxRetries: clampInt(env.AI_MAX_RETRIES, 0, 3, 2),
    // Protects the free-tier quota and the merchant from runaway requests.
    perShopPerMinute: clampInt(env.AI_MAX_REQUESTS_PER_MINUTE, 1, 60, 8),
    // Requests running at once across all shops on this server process.
    maxConcurrent: clampInt(env.AI_MAX_CONCURRENT, 1, 10, 2),
  };
}

export function aiStatus(env = process.env) {
  const c = readAiConfig(env);
  if (c.provider === "none") {
    return { enabled: false, provider: null, model: null, reason: "AI suggestions are turned off (no GEMINI_API_KEY configured). You can still review and edit every proposed fix manually." };
  }
  if (c.provider !== "gemini") {
    return { enabled: false, provider: c.provider, model: null, reason: `Unknown AI_PROVIDER "${c.provider}". AI suggestions are turned off.` };
  }
  if (!c.apiKey) return { enabled: false, provider: "gemini", model: null, reason: "GEMINI_API_KEY is not set. AI suggestions are turned off." };
  if (!c.model) return { enabled: false, provider: "gemini", model: null, reason: "GEMINI_MODEL is not set. Choose a currently available Gemini model (see README) and set GEMINI_MODEL. AI suggestions are turned off." };
  if (!c.modelValid) return { enabled: false, provider: "gemini", model: null, reason: "GEMINI_MODEL is not a valid model name. AI suggestions are turned off." };
  return { enabled: true, provider: "gemini", model: c.model, reason: null };
}
