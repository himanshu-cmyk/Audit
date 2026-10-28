// Provider abstraction. A provider is { name, model, generateJson({ system,
// prompt, schema, maxOutputTokens }) } returning parsed JSON or throwing AiError.
// To add a provider, implement that shape and register it below.

import { aiStatus, readAiConfig } from "./config.server";
import { aiError } from "./errors.server";
import { createGeminiProvider } from "./providers/gemini.server";

const FACTORIES = {
  gemini: (c, deps) =>
    createGeminiProvider({ apiKey: c.apiKey, model: c.model, timeoutMs: c.timeoutMs, maxRetries: c.maxRetries, ...deps }),
};

export function getAiProvider(env = process.env, deps = {}) {
  const status = aiStatus(env);
  if (!status.enabled) throw Object.assign(aiError("AI_DISABLED"), { message: status.reason });
  const c = readAiConfig(env);
  return FACTORIES[c.provider](c, deps);
}
