// Product / collection SEO title and description. The mutation only ever sends the
// `seo` input for the one approved resource. The field not being fixed is re-sent
// with its freshly fetched current value (or omitted when unset) so it cannot be
// cleared, and verification checks that it is still unchanged afterwards.

import crypto from "crypto";
import { VERIFY } from "../constants";
import {
  FIELD_RULES,
  suggestSeoDescription,
  suggestSeoTitle,
  validateTextValue,
} from "../content.server";
import { FixError, assertNoUserErrors, runGraphql } from "../graphql.server";
import { assertGid } from "../resolve.server";

export const PRODUCT_SEO_QUERY = `#graphql
  query StoreAuditProductSeo($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      vendor
      productType
      templateSuffix
      descriptionHtml
      description(truncateAt: 600)
      seo {
        title
        description
      }
    }
  }`;

export const PRODUCT_SEO_UPDATE = `#graphql
  mutation StoreAuditProductSeoUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        seo {
          title
          description
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

export const COLLECTION_SEO_QUERY = `#graphql
  query StoreAuditCollectionSeo($id: ID!) {
    collection(id: $id) {
      id
      title
      handle
      templateSuffix
      descriptionHtml
      description(truncateAt: 600)
      seo {
        title
        description
      }
    }
  }`;

export const COLLECTION_SEO_UPDATE = `#graphql
  mutation StoreAuditCollectionSeoUpdate($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection {
        id
        seo {
          title
          description
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

const CONFIG = {
  Product: {
    query: PRODUCT_SEO_QUERY,
    root: "product",
    mutation: PRODUCT_SEO_UPDATE,
    inputVar: "product",
    payload: "productUpdate",
    payloadRoot: "product",
  },
  Collection: {
    query: COLLECTION_SEO_QUERY,
    root: "collection",
    mutation: COLLECTION_SEO_UPDATE,
    inputVar: "collection",
    payload: "collectionUpdate",
    payloadRoot: "collection",
  },
};

const norm = (v) => (typeof v === "string" ? v.trim() : "");

// Fields this fix must never change. Compared before/after every mutation.
function guardOf(r) {
  return {
    title: r.title,
    handle: r.handle,
    status: r.status ?? null,
    vendor: r.vendor ?? null,
    productType: r.productType ?? null,
    templateSuffix: r.templateSuffix ?? null,
    descriptionSha256: crypto.createHash("sha256").update(r.descriptionHtml ?? "", "utf8").digest("hex"),
  };
}

// Same thresholds as the audit tool's SEO detector.
const RENDERED_RANGE = { title: [15, 65], description: [50, 165] };

function rootCauseError(message) {
  return new FixError("ROOT_CAUSE_NOT_ADMIN_DATA", message);
}

/**
 * Checks that the finding is actually caused by this resource's Admin data
 * before proposing a change. Throws ROOT_CAUSE_NOT_ADMIN_DATA otherwise.
 * Shopify renders page_title from seo.title (else the item title) and
 * page_description from seo.description (else the item description).
 */
function assertRootCause(field, auditId, current, resourceType) {
  const item = resourceType.toLowerCase();
  if (field === "description") {
    const effective = norm(current.seoDescription) || norm(current.description);
    if (auditId === "seo.meta-description.missing" && effective) {
      throw rootCauseError(
        `This ${item} already has ${norm(current.seoDescription) ? "an SEO description" : "description text that Shopify uses as the meta description"}, so the missing meta tag is most likely caused by the theme not outputting it (check layout/theme.liquid or its meta-tags snippet). Changing Admin data would not fix it.`,
      );
    }
    if (auditId === "seo.meta-description.length" && effective) {
      const [min, max] = RENDERED_RANGE.description;
      if (effective.length >= min && effective.length <= max) {
        throw rootCauseError(
          `This ${item}'s effective meta description is ${effective.length} characters, which is already within range, so the length the audit saw comes from somewhere else (theme or an app). Review it manually.`,
        );
      }
    }
  }
  if (field === "title" && auditId === "seo.title.length") {
    const effective = norm(current.seoTitle) || norm(current.title);
    if (effective.length >= 15 && effective.length <= 60) {
      throw rootCauseError(
        `This ${item}'s effective title is ${effective.length} characters, already within range. The page title the audit saw is probably lengthened by the theme (for example a store-name suffix), so changing Admin data is not a reliable fix. Review the theme manually.`,
      );
    }
  }
}

export function makeSeoHandler({ resourceType, field }) {
  const cfg = CONFIG[resourceType];
  const key = field === "title" ? "seoTitle" : "seoDescription";
  const otherKey = field === "title" ? "seoDescription" : "seoTitle";
  const otherField = field === "title" ? "description" : "title";
  const rules = field === "title" ? FIELD_RULES.seoTitle : FIELD_RULES.seoDescription;

  async function fetchCurrent(ctx, resourceId) {
    assertGid(resourceType, resourceId);
    const data = await runGraphql(ctx.admin, cfg.query, { id: resourceId });
    const r = data[cfg.root];
    if (!r) throw new FixError("NOT_FOUND", `${resourceType} was not found in this store.`);
    return {
      id: r.id,
      title: r.title,
      handle: r.handle,
      description: r.description ?? "",
      seoTitle: r.seo?.title ?? null,
      seoDescription: r.seo?.description ?? null,
      guard: guardOf(r),
    };
  }

  return {
    field: { name: key, ...rules },

    async prepare(ctx, target) {
      const current = await fetchCurrent(ctx, target.resource.id);
      if (target.finding) assertRootCause(field, target.finding.auditId, current, resourceType);
      const suggestion =
        field === "title"
          ? suggestSeoTitle({
              resourceTitle: current.title,
              currentSeoTitle: current.seoTitle,
              shopName: ctx.shopName,
            })
          : suggestSeoDescription({
              currentSeoDescription: current.seoDescription,
              plainDescription: current.description,
            });
      return [
        {
          resourceType,
          resourceId: current.id,
          resourceLabel: current.title,
          targetUrl: target.url,
          before: {
            title: current.title,
            handle: current.handle,
            seoTitle: current.seoTitle,
            seoDescription: current.seoDescription,
            guard: current.guard,
          },
          proposed: { value: suggestion.value, note: suggestion.note },
        },
      ];
    },

    fetchCurrent: (ctx, plan) => fetchCurrent(ctx, plan.resourceId),
    beforeValue: (snapshot) => snapshot?.[key] ?? null,
    isStale: (before, current) => norm(before?.[key]) !== norm(current?.[key]),
    validate: (value, current) => validateTextValue(value, rules, { previous: current?.[key] }),
    alreadyApplied: (current, approvedValue) => norm(current?.[key]) === approvedValue,

    async apply(ctx, plan, approvedValue, current) {
      const seo = { [field]: approvedValue };
      if (typeof current[otherKey] === "string") seo[otherField] = current[otherKey];
      const data = await runGraphql(
        ctx.admin,
        cfg.mutation,
        { [cfg.inputVar]: { id: plan.resourceId, seo } },
        { mutation: true },
      );
      const payload = data[cfg.payload];
      if (!payload) throw new FixError("GRAPHQL_ERROR", "Shopify returned no mutation result.");
      assertNoUserErrors(payload.userErrors, `${resourceType} SEO update`);
      const saved = payload[cfg.payloadRoot]?.seo;
      return {
        mutation: cfg.payload,
        returned: { seoTitle: saved?.title ?? null, seoDescription: saved?.description ?? null },
      };
    },

    async verify(ctx, plan, approvedValue, preApply) {
      const after = await fetchCurrent(ctx, plan.resourceId);
      const actual = norm(after[key]);
      const otherUnchanged = norm(after[otherKey]) === norm(preApply[otherKey]);
      const changedGuards = preApply.guard
        ? Object.keys(preApply.guard).filter((k) => preApply.guard[k] !== after.guard[k])
        : [];
      const details = { field: rules.label, expected: approvedValue, actual: after[key], changedGuards };
      if (actual === approvedValue && otherUnchanged && changedGuards.length === 0) {
        return { status: VERIFY.PASSED, details, message: `${rules.label} saved as approved.` };
      }
      return {
        status: VERIFY.FAILED,
        details: { ...details, otherFieldChanged: !otherUnchanged },
        message:
          actual !== approvedValue
            ? `Saved ${rules.label.toLowerCase()} does not match the approved value.`
            : !otherUnchanged
              ? "The approved value was saved, but another SEO field changed unexpectedly."
              : `The approved value was saved, but other fields changed during the update (${changedGuards.join(", ")}). Check this item in Shopify Admin.`,
      };
    },
  };
}
