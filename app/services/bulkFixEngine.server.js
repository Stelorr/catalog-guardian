import prisma from "../db.server.js";
import { SET_METAFIELDS } from "../graphql/setMetafields.js";
import { classifyMetafield } from "./scanEngine.server.js";
import { graphqlRequest, pauseForCapacity } from "./shopifyGraphql.server.js";

// metafieldsSet is atomic per call — if any entry in a batched call is
// invalid, Shopify persists nothing for that entire call, not just the bad
// entry. Batching several products into one call would therefore make a
// single bad product silently block every other product in the same call,
// which is incompatible with reporting real per-product partial failures.
// So this issues one metafieldsSet call per product instead: heavier on
// request count, but it's the only way to get true per-product granularity.
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

  const results = [];

  for (const target of targets) {
    try {
      const { data, cost } = await graphqlRequest(
        admin,
        SET_METAFIELDS,
        {
          metafields: [
            {
              ownerId: target.productId,
              namespace: target.namespace,
              key: target.key,
              type: target.expectedType,
              value,
            },
          ],
        },
        () => {},
      );

      const userErrors = data.metafieldsSet.userErrors;
      if (userErrors.length > 0) {
        results.push({
          id: target.id,
          productTitle: target.productTitle,
          success: false,
          error: userErrors.map((e) => e.message).join("; "),
        });
      } else {
        results.push({ id: target.id, productTitle: target.productTitle, success: true });
      }

      await pauseForCapacity(cost, () => {});
    } catch (error) {
      results.push({
        id: target.id,
        productTitle: target.productTitle,
        success: false,
        error: error.message,
      });
    }
  }

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
