// Thin wrapper around the authenticated Admin GraphQL client from
// authenticate.admin(). Callers pass fixed, allowlisted documents defined in this
// codebase; nothing from the browser or an audit file is ever used as a query.

import { cleanLine } from "./text";

export class FixError extends Error {
  constructor(code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.name = "FixError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function graphqlErrorsOf(err) {
  const list = err?.body?.errors?.graphQLErrors;
  return Array.isArray(list) ? list : null;
}

function toFixErrorFromGraphql(list) {
  if (list.some((e) => e?.extensions?.code === "ACCESS_DENIED")) {
    return new FixError(
      "ACCESS_DENIED",
      "Shopify denied access. The app may be missing a required permission (scope).",
    );
  }
  const msg = list
    .map((e) => cleanLine(e?.message, 300))
    .filter(Boolean)
    .join("; ");
  return new FixError("GRAPHQL_ERROR", msg || "Shopify returned a GraphQL error.");
}

/**
 * Runs a GraphQL document and returns `data`. Throws FixError for every failure
 * mode so callers can record a safe, displayable message.
 */
export async function runGraphql(
  admin,
  document,
  variables = {},
  { mutation = false, maxThrottleRetries = 3, sleep = defaultSleep } = {},
) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      // Queries may use the client's built-in retry for 429/5xx. Mutations are
      // sent once so a network-level retry can never apply a change twice.
      response = await admin.graphql(document, {
        variables,
        ...(mutation ? {} : { tries: 2 }),
      });
    } catch (err) {
      if (err instanceof Response) {
        if (err.status === 401) {
          throw new FixError(
            "SESSION_EXPIRED",
            "Your Shopify session expired. Reload the app and try again.",
            { retryable: true },
          );
        }
        if (err.status === 403) {
          throw new FixError(
            "ACCESS_DENIED",
            "Shopify denied access. The app may be missing a required permission (scope).",
          );
        }
        if (err.status === 429 && attempt < maxThrottleRetries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new FixError("HTTP_ERROR", `Shopify returned HTTP ${err.status}.`, {
          retryable: err.status === 429 || err.status >= 500,
        });
      }
      const list = graphqlErrorsOf(err);
      if (list) {
        if (list.some((e) => e?.extensions?.code === "THROTTLED")) {
          if (attempt < maxThrottleRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw new FixError("THROTTLED", "Shopify rate limit reached. Try again in a minute.", {
            retryable: true,
          });
        }
        throw toFixErrorFromGraphql(list);
      }
      throw new FixError("NETWORK_ERROR", "Could not reach Shopify. Try again.", {
        retryable: true,
      });
    }

    const json = await response.json();
    if (Array.isArray(json?.errors) && json.errors.length) {
      throw toFixErrorFromGraphql(json.errors);
    }
    if (!json?.data) {
      throw new FixError("GRAPHQL_ERROR", "Shopify returned an empty response.", {
        retryable: true,
      });
    }
    return json.data;
  }
}

export function assertNoUserErrors(userErrors, what) {
  if (Array.isArray(userErrors) && userErrors.length) {
    const msg = userErrors
      .map((e) => {
        const field = Array.isArray(e?.field) ? e.field.join(".") : "";
        return cleanLine(`${field ? `${field}: ` : ""}${e?.message ?? ""}`, 300);
      })
      .join("; ");
    const denied = userErrors.some((e) => e?.code === "ACCESS_DENIED");
    throw new FixError(denied ? "ACCESS_DENIED" : "USER_ERRORS", `${what} was rejected by Shopify: ${msg}`, {
      details: userErrors.map((e) => ({ field: e?.field ?? null, message: cleanLine(e?.message, 300), code: e?.code ?? null })),
    });
  }
}
