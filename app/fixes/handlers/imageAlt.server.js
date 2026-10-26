// Product image alt text. In API 2026-07 productUpdateMedia is deprecated in favour
// of fileUpdate, which updates a MediaImage's `alt`. Before every read/write the
// image is re-fetched through its parent product, so an ID that does not belong to
// that product (in this shop) is rejected.

import { VERIFY } from "../constants";
import { FIELD_RULES, suggestAltText, validateTextValue } from "../content.server";
import { FixError, assertNoUserErrors, runGraphql } from "../graphql.server";
import { assertGid } from "../resolve.server";

export const PRODUCT_MEDIA_QUERY = `#graphql
  query StoreAuditProductMedia($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      media(first: 100) {
        nodes {
          id
          alt
          status
          mediaContentType
          ... on MediaImage {
            image {
              url
            }
          }
        }
      }
    }
  }`;

export const MEDIA_ALT_UPDATE = `#graphql
  mutation StoreAuditMediaAltUpdate($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        alt
      }
      userErrors {
        field
        message
        code
      }
    }
  }`;

const norm = (v) => (typeof v === "string" ? v.trim() : "");

function cdnImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)shopify(cdn)?\.com$|(^|\.)shopifycdn\.net$/.test(u.hostname)
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

async function fetchProductImages(ctx, productId) {
  assertGid("Product", productId);
  const data = await runGraphql(ctx.admin, PRODUCT_MEDIA_QUERY, { id: productId });
  const p = data.product;
  if (!p) throw new FixError("NOT_FOUND", "Product was not found in this store.");
  const images = (p.media?.nodes || [])
    .map((m, i) => ({ ...m, position: i + 1 }))
    .filter((m) => m.mediaContentType === "IMAGE");
  return { product: p, images };
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeImageAltHandler() {
  const rules = FIELD_RULES.altText;

  async function fetchCurrent(ctx, plan) {
    assertGid("MediaImage", plan.resourceId);
    const { product, images } = await fetchProductImages(ctx, plan.parentResourceId);
    const media = images.find((m) => m.id === plan.resourceId);
    if (!media) {
      throw new FixError("NOT_FOUND", "This image no longer belongs to the product in this store.");
    }
    if (media.status !== "READY") {
      throw new FixError("MEDIA_NOT_READY", `This image is not ready in Shopify (status ${media.status}), so its alt text cannot be updated safely.`);
    }
    return {
      productId: product.id,
      productTitle: product.title,
      mediaId: media.id,
      position: media.position,
      alt: media.alt ?? null,
      imageUrl: cdnImageUrl(media.image?.url),
    };
  }

  return {
    field: { name: "alt", ...rules },

    async prepare(ctx, target) {
      const { product, images } = await fetchProductImages(ctx, target.resource.id);
      // Only READY images: alt updates on processing or failed media are unreliable.
      const missing = images.filter((m) => !norm(m.alt) && m.status === "READY");
      return missing.map((m) => {
        const suggestion = suggestAltText({
          productTitle: product.title,
          imageCountNeedingAlt: missing.length,
        });
        return {
          resourceType: "MediaImage",
          resourceId: m.id,
          parentResourceId: product.id,
          resourceLabel: `${product.title} (image ${m.position})`,
          targetUrl: target.url,
          before: {
            productId: product.id,
            productTitle: product.title,
            mediaId: m.id,
            position: m.position,
            alt: m.alt ?? null,
            imageUrl: cdnImageUrl(m.image?.url),
          },
          proposed: { value: suggestion.value, note: suggestion.note },
        };
      });
    },

    fetchCurrent,
    beforeValue: (snapshot) => snapshot?.alt ?? null,
    isStale: (before, current) => norm(before?.alt) !== norm(current?.alt),
    validate: (value, current) => validateTextValue(value, rules, { previous: current?.alt }),
    alreadyApplied: (current, approvedValue) => norm(current?.alt) === approvedValue,

    async apply(ctx, plan, approvedValue) {
      const data = await runGraphql(
        ctx.admin,
        MEDIA_ALT_UPDATE,
        { files: [{ id: plan.resourceId, alt: approvedValue }] },
        { mutation: true },
      );
      const payload = data.fileUpdate;
      if (!payload) throw new FixError("GRAPHQL_ERROR", "Shopify returned no mutation result.");
      assertNoUserErrors(payload.userErrors, "Image alt text update");
      const file = (payload.files || []).find((f) => f.id === plan.resourceId);
      return { mutation: "fileUpdate", returned: { alt: file?.alt ?? null } };
    },

    async verify(ctx, plan, approvedValue) {
      const sleep = ctx.sleep || sleepDefault;
      let after;
      // File updates can be processed asynchronously; allow one short re-check.
      for (let attempt = 0; attempt < 2; attempt++) {
        after = await fetchCurrent(ctx, plan);
        if (norm(after.alt) === approvedValue) {
          return {
            status: VERIFY.PASSED,
            details: { field: rules.label, expected: approvedValue, actual: after.alt },
            message: "Alt text saved as approved.",
          };
        }
        if (attempt === 0) await sleep(1500);
      }
      return {
        status: VERIFY.FAILED,
        details: { field: rules.label, expected: approvedValue, actual: after.alt },
        message: "Saved alt text does not match the approved value.",
      };
    },
  };
}
