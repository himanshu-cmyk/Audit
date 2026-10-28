// Errors from the AI layer. Messages are safe to show to merchants and never
// contain the API key or raw provider responses.
export class AiError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const AI_ERROR_MESSAGES = {
  AI_DISABLED: "AI suggestions are not available.",
  AI_TIMEOUT: "The AI service did not respond in time. Try again, or edit the proposal manually.",
  AI_QUOTA: "The AI service quota is used up for now (free-tier limit). Try again later, or edit the proposal manually.",
  AI_RATE_LIMITED: "Too many AI requests right now. Wait a minute and try again.",
  AI_AUTH: "The AI service rejected the API key or project. Check GEMINI_API_KEY.",
  AI_BAD_REQUEST: "The AI service rejected the request. Check GEMINI_MODEL.",
  AI_UNAVAILABLE: "The AI service is temporarily unavailable. Try again later, or edit the proposal manually.",
  AI_BLOCKED: "The AI service declined to answer this request.",
  AI_INVALID_RESPONSE: "The AI returned a response that could not be used.",
};

export const aiError = (code, opts) => new AiError(code, AI_ERROR_MESSAGES[code] || "AI request failed.", opts);
