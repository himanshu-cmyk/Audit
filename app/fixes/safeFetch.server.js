// Bounded, SSRF-resistant HTTPS GET for the storefront re-check. It is only ever
// called with a URL the server built from the shop's own domain (never from a
// report), but it still enforces:
//  - https only, default port only, no credentials in the URL
//  - every hop's host must be in an explicit allowlist
//  - every resolved address must be public (IPv4 and IPv6, including mapped and
//    embedded IPv4); the check runs inside the socket's DNS lookup, so the
//    address that is validated is the address that is connected to (no DNS
//    rebinding window)
//  - bounded redirects, one overall deadline and a response size cap

import dns from "node:dns";
import https from "node:https";
import net from "node:net";

export class SafeFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  BLOCKED.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  BLOCKED.addSubnet(prefix, bits, "ipv6");
}

function expandIpv6(ip) {
  let s = ip.toLowerCase().split("%")[0];
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) becomes two hex groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = s.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
}

const v4FromGroups = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  if (family !== 6) return false;
  if (BLOCKED.check(ip, "ipv6")) return false;
  const g = expandIpv6(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return false;
  // IPv4-mapped / IPv4-compatible (::ffff:a.b.c.d, ::a.b.c.d) and NAT64 (64:ff9b::/96).
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  if ((zeros(5) && g[5] === 0xffff) || zeros(6)) return isPublicAddress(v4FromGroups(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(v4FromGroups(g[6], g[7]));
  // 6to4 (2002:AABB:CCDD::/16) embeds an IPv4 address.
  if (g[0] === 0x2002) return isPublicAddress(v4FromGroups(g[1], g[2]));
  return true;
}

/** dns.lookup replacement that refuses non-public results. */
export function makeSafeLookup(resolve = dns.lookup) {
  return function safeLookup(hostname, options, callback) {
    const opts = typeof options === "function" ? {} : options || {};
    const cb = typeof options === "function" ? options : callback;
    resolve(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
        return cb(new SafeFetchError("BLOCKED_ADDRESS", `Refusing to connect: ${hostname} resolves to a non-public address.`));
      }
      return opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    });
  };
}

export function checkUrl(href, allowedHosts) {
  let u;
  try {
    u = new URL(href);
  } catch {
    throw new SafeFetchError("INVALID_URL", "Invalid URL.");
  }
  if (u.protocol !== "https:") throw new SafeFetchError("INVALID_URL", "Only https URLs are fetched.");
  if (u.username || u.password) throw new SafeFetchError("INVALID_URL", "URLs with credentials are not fetched.");
  if (u.port && u.port !== "443") throw new SafeFetchError("INVALID_URL", "Only the default https port is allowed.");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new SafeFetchError("HOST_NOT_ALLOWED", `Host ${host} is not on the allowlist.`);
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && !isPublicAddress(literal)) {
    throw new SafeFetchError("BLOCKED_ADDRESS", "Refusing to connect to a non-public address.");
  }
  return u;
}

// One request, no redirect following. Resolves { status, headers, text, truncated }.
export function httpsRequestOnce(url, { signal, maxBytes, headers, method = "GET", body = null, lookup = makeSafeLookup() }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, lookup, signal }, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk) => {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          res.destroy();
          return finish();
        }
        chunks.push(chunk);
      });
      const finish = () =>
        resolve({
          status: res.statusCode,
          headers: {
            location: res.headers.location ?? null,
            contentType: res.headers["content-type"] ?? null,
            setCookie: res.headers["set-cookie"] ?? [],
            // Diagnostics only (never cookies or bodies): who answered, and when to retry.
            retryAfter: res.headers["retry-after"] ?? null,
            server: typeof res.headers.server === "string" ? res.headers.server.slice(0, 60) : null,
          },
          text: Buffer.concat(chunks).toString("utf8"),
          truncated,
        });
      res.on("end", finish);
      res.on("error", (e) => (truncated ? finish() : reject(e)));
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

/**
 * GET (or a form POST) with per-hop validation. Redirects are followed only to allowlisted hosts,
 * up to maxRedirects; with maxRedirects 0 the 3xx response is returned as is.
 */
export async function safeFetchText(href, {
  allowedHosts,
  maxRedirects = 0,
  timeoutMs = 8000,
  maxBytes = 2_000_000,
  headers = {},
  method = "GET",
  body = null,
  requestOnce = httpsRequestOnce,
} = {}) {
  if (!["GET", "POST"].includes(method)) throw new SafeFetchError("INVALID_URL", "Only GET and POST are allowed.");
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) throw new SafeFetchError("HOST_NOT_ALLOWED", "No allowed hosts.");
  const signal = AbortSignal.timeout(timeoutMs);
  let current = checkUrl(href, allowedHosts);
  for (let hop = 0; ; hop++) {
    let res;
    try {
      // A redirect is always followed with GET and no body.
      res = await requestOnce(current.toString(), hop === 0 ? { signal, maxBytes, headers, method, body } : { signal, maxBytes, headers });
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      if (err?.cause instanceof SafeFetchError) throw err.cause;
      if (signal.aborted) throw new SafeFetchError("TIMEOUT", "The request timed out.");
      throw new SafeFetchError("NETWORK", "The request failed.");
    }
    const redirect = res.status >= 300 && res.status < 400 && res.headers.location;
    if (!redirect || hop >= maxRedirects) return { ...res, url: current.toString(), redirects: hop };
    current = checkUrl(new URL(res.headers.location, current).toString(), allowedHosts);
  }
}
