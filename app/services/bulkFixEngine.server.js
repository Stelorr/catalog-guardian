import prisma from "../db.server.js";
import { GET_PRODUCT_METAFIELD } from "../graphql/getProductMetafield.js";
import { SET_METAFIELDS } from "../graphql/setMetafields.js";
import { classifyMetafield } from "./scanEngine.server.js";
import { graphqlRequest, pauseForCapacity } from "./shopifyGraphql.server.js";

// metafieldsSet returns these when the compareDigest no longer matches the
// stored value, i.e. someone changed it after we read it.
const STALE_ERROR_CODES = new Set(["STALE_OBJECT", "INVALID_COMPARE_DIGEST"]);
export const STALE_MESSAGE = "Value changed in Shopify since the scan; re-scan to refresh.";

const noLog = () => {};

// Writes one value per target, in order, and returns one
// { outcome: "applied" | "stale" | "failed", error? } per target.
//
// metafieldsSet is atomic per call — if any entry in a batched call is
// invalid, Shopify persists nothing for that entire call, not just the bad
// entry. Batching several products into one call would therefore make a
// single bad product silently block every other product in the same call,
// which is incompatible with reporting real per-product partial failures.
// So this issues one metafieldsSet call per product instead: heavier on
// request count, but it's the only way to get true per-product granularity.
//
// When a target has expectedValue, the current value is re-read first. If
// it no longer matches, nothing is written and the result is "stale".
// Otherwise the write carries the value's compareDigest, so a change made
// between the read and the write is also caught as "stale" by Shopify.
export async function applyMetafieldValues(admin, targets) {
  const results = [];

  for (const target of targets) {
    try {
      const input = {
        ownerId: target.productId,
        namespace: target.namespace,
        key: target.key,
        type: target.type,
        value: target.value,
      };

      if (target.expectedValue !== undefined) {
        const { data, cost } = await graphqlRequest(
          admin,
          GET_PRODUCT_METAFIELD,
          { productId: target.productId, namespace: target.namespace, key: target.key },
          noLog,
        );
        await pauseForCapacity(cost, noLog);

        const current = data.product?.metafield ?? null;
        if ((current?.value ?? null) !== target.expectedValue) {
          results.push({ outcome: "stale", error: STALE_MESSAGE });
          continue;
        }
        // A null digest tells Shopify to write only if the metafield still
        // doesn't exist.
        input.compareDigest = current?.compareDigest ?? null;
      }

      const { data, cost } = await graphqlRequest(admin, SET_METAFIELDS, { metafields: [input] }, noLog);
      await pauseForCapacity(cost, noLog);

      const userErrors = data.metafieldsSet.userErrors;
      const message = userErrors.map((e) => e.message).join("; ");
      if (userErrors.some((e) => STALE_ERROR_CODES.has(e.code))) {
        results.push({ outcome: "stale", error: `${STALE_MESSAGE} (${message})` });
      } else if (userErrors.length > 0) {
        results.push({ outcome: "failed", error: message });
      } else {
        results.push({ outcome: "applied" });
      }
    } catch (error) {
      results.push({ outcome: "failed", error: error.message });
    }
  }

  return results;
}

// Sets the same value on every selected issue row. No stale check: this is
// the merchant typing a value for rows the Issues page just showed them.
export async function bulkFixMetafield({ admin, shop, scanResultIds, value }) {
  const targets = await prisma.scanResult.findMany({
    where: { id: { in: scanResultIds }, shop },
  });

  if (targets.length === 0) {
    throw new Error("No matching issues found for the selected rows.");
  }

  const distinctKeys = new Set(targets.map((t) => `${t.namespace}.${t.key}`));
  if (distinctKeys.size > 1) {
    throw new Error("Selected rows must all share the same metafield.");
  }

  const outcomes = await applyMetafieldValues(
    admin,
    targets.map((t) => ({
      productId: t.productId,
      namespace: t.namespace,
      key: t.key,
      type: t.expectedType,
      value,
    })),
  );

  const results = targets.map((target, i) => ({
    id: target.id,
    productTitle: target.productTitle,
    success: outcomes[i].outcome === "applied",
    ...(outcomes[i].error ? { error: outcomes[i].error } : {}),
  }));

  const succeededIds = results.filter((r) => r.success).map((r) => r.id);
  if (succeededIds.length > 0) {
    // All targets share one namespace/key/expectedType (enforced above) and
    // every success was set to the same value, so the resulting status is
    // identical for all of them — reuse the scan engine's own classification
    // rather than assuming "OK", since e.g. a bulk-set to "[]" on a list
    // type would still be EMPTY per Phase 4's rules even though Shopify
    // accepted the write.
    const { namespace, key, expectedType } = targets[0];
    const { status } = classifyMetafield(
      { namespace, key, type: { name: expectedType } },
      { namespace, key, value, type: expectedType },
    );

    await prisma.scanResult.updateMany({
      where: { id: { in: succeededIds } },
      data: { status, actualValue: value, lastCheckedAt: new Date() },
    });
  }

  return results;
}

const PROPOSAL_STATUS_BY_OUTCOME = { applied: "APPLIED", stale: "STALE", failed: "FAILED" };

// Applies APPROVED proposals, each with its own value, and only if the value
// in Shopify still equals the one the proposal was made from. Anything that
// changed since the scan ends STALE and is not overwritten.
export async function applyApprovedProposals({ admin, shop, proposalIds }) {
  const proposals = await prisma.fixProposal.findMany({
    where: { id: { in: proposalIds }, shop, status: "APPROVED" },
  });

  if (proposals.length === 0) {
    throw new Error("No approved proposals found for the selected rows.");
  }

  const outcomes = await applyMetafieldValues(
    admin,
    proposals.map((p) => ({
      productId: p.productId,
      namespace: p.namespace,
      key: p.key,
      type: p.valueType,
      value: p.proposedValue,
      expectedValue: p.originalValue,
    })),
  );

  const now = new Date();
  await prisma.$transaction(
    proposals.flatMap((p, i) => {
      const { outcome, error } = outcomes[i];
      const ops = [
        prisma.fixProposal.update({
          where: { id: p.id },
          data: {
            status: PROPOSAL_STATUS_BY_OUTCOME[outcome],
            errorMessage: error ?? null,
            appliedAt: outcome === "applied" ? now : null,
          },
        }),
      ];
      if (outcome === "applied") {
        // Proposals only come from OK values and keep the type, so the row
        // stays OK; only its value changes.
        ops.push(
          prisma.scanResult.updateMany({
            where: { shop, productId: p.productId, namespace: p.namespace, key: p.key },
            data: { actualValue: p.proposedValue, flagReason: null, lastCheckedAt: now },
          }),
        );
      }
      return ops;
    }),
  );

  // Carries what was changed so the Review page can name each fix.
  return proposals.map((p, i) => ({
    id: p.id,
    productTitle: p.productTitle,
    key: p.key,
    valueType: p.valueType,
    originalValue: p.originalValue,
    proposedValue: p.proposedValue,
    ...outcomes[i],
  }));
}
