// Per-audit storefront request manager, layered on safeFetchText (which enforces
// https, the host allowlist, public-IP-only DNS, timeouts and size limits).
//
//  - Requests run one at a time (concurrency 1) and the whole audit has a hard
//    request budget, retries included.
//  - Only 429 and 503 are retried, at most `maxRetries` times, waiting for a valid
//    Retry-After (if it is not longer than `maxDelayMs`) or capped exponential
//    backoff with jitter. Nothing else is retried.
//  - After a final 429 (rate limited) or 403 (blocked) the client stops: later
//    calls return { skipped: true } without touching the network, so the audit
//    does not keep hitting a storefront that has asked it to stop.
//  - Identical GETs are served from a short in-memory cache for this audit only.
//    The cache key includes a hash of the cookie header (never the cookie itself),
//    so a page fetched before the password login is not reused after it.

import crypto from "crypto";

export const CHECK_STATUS = {
  CHECKED: "checked",
  PARTIAL: "partial",
  NOT_CHECKED: "not_checked",
  RATE_LIMITED: "rate_limited",
  BLOCKED: "blocked",
  ERROR: "error",
  NOT_MEASURED: "not_measured",
};

export const STOREFRONT_LIMITS = { maxRequests: 40, maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, cacheTtlMs: 5 * 60 * 1000 };

const RETRYABLE = new Set([429, 503]);

/** Parses Retry-After (seconds or HTTP date). Returns milliseconds, or null if invalid. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export function backoffMs(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  // "Equal jitter": half fixed, half random, so waits never collapse to zero.
  return Math.round(exp / 2 + random() * (exp / 2));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createStorefrontClient({
  fetchPage,
  limits = STOREFRONT_LIMITS,
  sleep = defaultSleep,
  random = Math.random,
  now = Date.now,
}) {
  const cache = new Map();
  let requests = 0;
  let retries = 0;
  let cacheHits = 0;
  let stopped = null;

  const diagnostics = (res) => ({
    status: res.status,
    retryAfter: res.headers?.retryAfter ?? null,
    server: res.headers?.server ?? null,
  });

  async function request(url, opts = {}) {
    const method = opts.method || "GET";
    const cookieHash = opts.headers?.cookie ? crypto.createHash("sha256").update(opts.headers.cookie).digest("hex").slice(0, 16) : "";
    const key = `${method} ${url} ${cookieHash} ${opts.maxBytes ?? ""}`;
    if (method === "GET") {
      const hit = cache.get(key);
      if (hit && now() - hit.at < limits.cacheTtlMs) {
        cacheHits++;
        return hit.res;
      }
    }
    if (stopped) return { skipped: true, stopped };
    for (let attempt = 0; ; attempt++) {
      if (requests >= limits.maxRequests) {
        stopped = { kind: "budget", status: null };
        return { skipped: true, stopped };
      }
      requests++;
      const res = await fetchPage(url, opts);
      if (RETRYABLE.has(res.status) && attempt < limits.maxRetries) {
        const hinted = retryAfterMs(res.headers?.retryAfter, now());
        if (hinted !== null && hinted > limits.maxDelayMs) {
          // The storefront asked for a longer pause than this audit may wait.
          stopped = { kind: res.status === 429 ? "rate_limited" : "error", ...diagnostics(res) };
          return res;
        }
        retries++;
        await sleep(hinted ?? backoffMs(attempt, limits, random));
        continue;
      }
      if (res.status === 429) stopped = { kind: "rate_limited", ...diagnostics(res) };
      else if (res.status === 403) stopped = { kind: "blocked", ...diagnostics(res) };
      if (method === "GET" && !stopped) cache.set(key, { at: now(), res });
      return res;
    }
  }

  return {
    request,
    get stopped() {
      return stopped;
    },
    stats: () => ({ requests, retries, cacheHits }),
  };
}
