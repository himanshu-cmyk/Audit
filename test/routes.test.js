/* eslint-env node */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateAdmin: vi.fn(), db: { current: null } }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: (...args) => mocks.authenticateAdmin(...args) },
}));
// Any database access through this proxy fails loudly unless a test installs a fake.
vi.mock("../app/db.server", () => ({
  default: new Proxy(
    {},
    {
      get(_t, prop) {
        if (!mocks.db.current) throw new Error(`database touched: ${String(prop)}`);
        return mocks.db.current[prop];
      },
    },
  ),
}));

const routes = {
  audits: await import("../app/routes/app.audits._index.jsx"),
  dashboard: await import("../app/routes/app.audits.$importId.jsx"),
  review: await import("../app/routes/app.audits.$importId_.review.jsx"),
  history: await import("../app/routes/app.history.jsx"),
};

const req = (method = "GET", body) =>
  new Request("https://app.example.com/app/audits", { method, ...(body ? { body } : {}) });

beforeEach(() => {
  mocks.authenticateAdmin.mockReset();
  mocks.db.current = null;
});

describe("unauthorized or expired sessions", () => {
  it("every loader and action rejects before touching data", async () => {
    mocks.authenticateAdmin.mockRejectedValue(new Response(null, { status: 401 }));
    for (const [name, mod] of Object.entries(routes)) {
      for (const fn of ["loader", "action"]) {
        if (!mod[fn]) continue;
        const form = new FormData();
        form.set("intent", "execute");
        const p = mod[fn]({ request: req(fn === "action" ? "POST" : "GET", fn === "action" ? form : undefined), params: { importId: "abcdefghij12" } });
        await expect(p, `${name}.${fn}`).rejects.toBeInstanceOf(Response);
        await p.catch((r) => expect(r.status).toBe(401));
      }
    }
  });
});

describe("authenticated requests", () => {
  const session = { shop: "acme.myshopify.com", scope: "write_products" };
  beforeEach(() => {
    mocks.authenticateAdmin.mockResolvedValue({ admin: {}, session, redirect: vi.fn() });
  });

  it("returns 404 for an import that belongs to another shop", async () => {
    const findFirst = vi.fn(async () => null);
    mocks.db.current = { auditImport: { findFirst } };
    const p = routes.dashboard.loader({ request: req(), params: { importId: "abcdefghij12" } });
    await expect(p).rejects.toMatchObject({ status: 404 });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "abcdefghij12", shop: "acme.myshopify.com" } });
  });

  it("requires the explicit final confirmation before executing", async () => {
    const form = new FormData();
    form.set("intent", "execute");
    form.set("planIds", JSON.stringify(["abcdefghij12"]));
    const res = await routes.review.action({ request: req("POST", form), params: { importId: "abcdefghij12" } });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Confirm/) });
  });

  it("requires the exact confirmed batch token before executing", async () => {
    const form = new FormData();
    form.set("intent", "execute");
    form.set("confirmed", "yes");
    form.set("planIds", JSON.stringify(["abcdefghij12"]));
    const res = await routes.review.action({ request: req("POST", form), params: { importId: "abcdefghij12" } });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/exact list/) });
  });

  it("rejects malformed approval payloads without touching data", async () => {
    const form = new FormData();
    form.set("intent", "approve");
    form.set("items", "{not json");
    const res = await routes.review.action({ request: req("POST", form), params: { importId: "abcdefghij12" } });
    expect(res.ok).toBe(false);
  });

  it("rejects an import without a file", async () => {
    const res = await routes.audits.action({ request: req("POST", new FormData()), params: {} });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Choose a JSON file/) });
  });
});

describe("existing app routes and navigation are preserved", () => {
  it("keeps the original routes authenticating and the original nav links", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const nav = fs.readFileSync(path.join(__dirname, "../app/routes/app.jsx"), "utf8");
    for (const link of ['href="/app"', 'href="/app/additional"', 'href="/app/audits"', 'href="/app/history"']) {
      expect(nav).toContain(link);
    }
    mocks.authenticateAdmin.mockReset();
    mocks.authenticateAdmin.mockRejectedValue(new Response(null, { status: 401 }));
    const existing = {
      "app.jsx": await import("../app/routes/app.jsx"),
      "app._index.jsx": await import("../app/routes/app._index.jsx"),
      "auth.$.jsx": await import("../app/routes/auth.$.jsx"),
    };
    for (const [file, mod] of Object.entries(existing)) {
      await expect(mod.loader({ request: req(), params: {} }), file).rejects.toMatchObject({ status: 401 });
    }
  });
});
