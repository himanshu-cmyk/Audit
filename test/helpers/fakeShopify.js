/* eslint-env node */
// In-memory stand-in for the Shopify Admin GraphQL API, keyed by the operation
// names used in app/fixes. It keeps state, so a mutation followed by a read
// behaves like the real API. Interceptors can inject errors per operation.
// Used by unit tests and the dry-run script; it never talks to Shopify.

export const DEFAULT_SCOPES =
  "write_products,write_metaobjects,write_metaobject_definitions,read_themes,read_files,write_files,write_themes";

let nextId = 1000;
const gid = (type) => `gid://shopify/${type}/${nextId++}`;

export function createFakeShop({
  shop = "test-shop.myshopify.com",
  primaryHost = "www.example-store.com",
  name = "Example Store",
} = {}) {
  const state = {
    products: new Map(),
    collections: new Map(),
    themes: new Map(),
    calls: [],
    interceptors: {},
    ignoreWrites: false,
  };

  const api = {
    addProduct({ title, handle, description = "", seoTitle = null, seoDescription = null, images = [] }) {
      const p = {
        id: gid("Product"),
        title,
        handle,
        description,
        seo: { title: seoTitle, description: seoDescription },
        media: images.map((img) => ({ id: gid("MediaImage"), alt: img.alt ?? "", status: img.status || "READY", url: img.url || "https://cdn.shopify.com/s/files/1/0000/products/img.jpg" })),
      };
      state.products.set(p.id, p);
      return p;
    },
    addCollection({ title, handle, description = "", seoTitle = null, seoDescription = null }) {
      const c = { id: gid("Collection"), title, handle, description, seo: { title: seoTitle, description: seoDescription } };
      state.collections.set(c.id, c);
      return c;
    },
    addTheme({ name: themeName, role, files = {} }) {
      const t = { id: gid("OnlineStoreTheme"), name: themeName, role, processing: false, files: { ...files } };
      state.themes.set(t.id, t);
      return t;
    },
  };

  const findMedia = (id) => {
    for (const p of state.products.values()) {
      const m = p.media.find((x) => x.id === id);
      if (m) return m;
    }
    return null;
  };
  const byHandle = (map, handle) => [...map.values()].find((x) => x.handle === handle) || null;
  const seoOut = (r) => ({ title: r.seo.title, description: r.seo.description });
  const applySeo = (r, seo) => {
    if (state.ignoreWrites) return;
    if ("title" in seo) r.seo.title = seo.title;
    if ("description" in seo) r.seo.description = seo.description;
  };

  const ops = {
    StoreAuditShopInfo: () => ({ shop: { name, myshopifyDomain: shop, primaryDomain: { host: primaryHost } } }),
    StoreAuditProductByHandle: ({ handle }) => {
      const p = byHandle(state.products, handle);
      return { productByIdentifier: p ? { id: p.id, title: p.title, handle: p.handle } : null };
    },
    StoreAuditCollectionByHandle: ({ handle }) => {
      const c = byHandle(state.collections, handle);
      return { collectionByIdentifier: c ? { id: c.id, title: c.title, handle: c.handle } : null };
    },
    StoreAuditProductSeo: ({ id }) => {
      const p = state.products.get(id);
      return { product: p ? { id: p.id, title: p.title, handle: p.handle, status: p.status || "ACTIVE", vendor: p.vendor || "Acme", productType: "", templateSuffix: null, descriptionHtml: p.descriptionHtml ?? `<p>${p.description}</p>`, description: p.description, seo: seoOut(p) } : null };
    },
    StoreAuditProductSeoUpdate: ({ product }) => {
      const p = state.products.get(product.id);
      if (!p) return { productUpdate: { product: null, userErrors: [{ field: ["id"], message: "Product does not exist" }] } };
      applySeo(p, product.seo || {});
      return { productUpdate: { product: { id: p.id, seo: seoOut(p) }, userErrors: [] } };
    },
    StoreAuditCollectionSeo: ({ id }) => {
      const c = state.collections.get(id);
      return { collection: c ? { id: c.id, title: c.title, handle: c.handle, templateSuffix: null, descriptionHtml: `<p>${c.description}</p>`, description: c.description, seo: seoOut(c) } : null };
    },
    StoreAuditCollectionSeoUpdate: ({ collection }) => {
      const c = state.collections.get(collection.id);
      if (!c) return { collectionUpdate: { collection: null, userErrors: [{ field: ["id"], message: "Collection does not exist" }] } };
      applySeo(c, collection.seo || {});
      return { collectionUpdate: { collection: { id: c.id, seo: seoOut(c) }, userErrors: [] } };
    },
    StoreAuditProductMedia: ({ id }) => {
      const p = state.products.get(id);
      return {
        product: p
          ? {
              id: p.id,
              title: p.title,
              handle: p.handle,
              media: { nodes: p.media.map((m) => ({ id: m.id, alt: m.alt, status: m.status, mediaContentType: "IMAGE", image: { url: m.url } })) },
            }
          : null,
      };
    },
    StoreAuditMediaAltUpdate: ({ files }) => {
      const out = [];
      for (const f of files) {
        const m = findMedia(f.id);
        if (!m) return { fileUpdate: { files: [], userErrors: [{ field: ["files", "0", "id"], message: "File does not exist", code: "FILE_DOES_NOT_EXIST" }] } };
        if (!state.ignoreWrites) m.alt = f.alt;
        out.push({ id: m.id, alt: m.alt });
      }
      return { fileUpdate: { files: out, userErrors: [] } };
    },
    StoreAuditThemes: () => ({
      themes: { nodes: [...state.themes.values()].map((t) => ({ id: t.id, name: t.name, role: t.role, processing: t.processing, updatedAt: "2026-10-01T00:00:00Z" })) },
    }),
    StoreAuditThemeFile: ({ id, filenames }) => {
      const t = state.themes.get(id);
      if (!t) return { theme: null };
      const nodes = filenames
        .filter((f) => typeof t.files[f] === "string")
        .map((f) => ({ filename: f, checksumMd5: null, body: { content: t.files[f] } }));
      return { theme: { id: t.id, name: t.name, role: t.role, processing: t.processing, files: { nodes } } };
    },
    StoreAuditThemeFilesUpsert: ({ themeId, files }) => {
      const t = state.themes.get(themeId);
      if (state.themeWriteDenied) {
        return { themeFilesUpsert: { job: null, upsertedThemeFiles: [], userErrors: [{ filename: files[0].filename, code: "ACCESS_DENIED", field: null, message: "Access denied" }] } };
      }
      for (const f of files) if (!state.ignoreWrites) t.files[f.filename] = f.body.value;
      return {
        themeFilesUpsert: {
          job: { id: "gid://shopify/Job/1", done: false },
          upsertedThemeFiles: files.map((f) => ({ filename: f.filename, checksumMd5: null })),
          userErrors: [],
        },
      };
    },
    StoreAuditJob: ({ id }) => ({ job: { id, done: true } }),
  };

  const admin = {
    async graphql(document, options = {}) {
      const match = document.match(/(?:query|mutation)\s+(\w+)/);
      const opName = match?.[1];
      const variables = options.variables || {};
      state.calls.push({ name: opName, variables: JSON.parse(JSON.stringify(variables)) });
      const intercept = state.interceptors[opName];
      if (intercept) {
        const r = await intercept(variables, state);
        if (r !== undefined) return r;
      }
      if (!ops[opName]) throw new Error(`Fake Shopify: unexpected operation ${opName}`);
      return new Response(JSON.stringify({ data: ops[opName](variables) }));
    },
  };

  return { admin, state, api, session: { shop, scope: DEFAULT_SCOPES } };
}

// Shapes matching what @shopify/shopify-api throws.
export function graphqlQueryError(messages, code) {
  const err = new Error(messages[0]);
  err.name = "GraphqlQueryError";
  err.body = { errors: { graphQLErrors: messages.map((m) => ({ message: m, extensions: code ? { code } : {} })) } };
  return err;
}
