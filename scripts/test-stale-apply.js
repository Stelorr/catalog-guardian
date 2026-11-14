// Manual end-to-end test of the STALE path against a real dev store.
// It needs you to edit one metafield in the Shopify admin while it waits.
//
//   npm run test:stale -- <shop>.myshopify.com
//
// Phase A: you change the value before Apply. The re-read sees the change,
//   so nothing is written.
// Phase B: the script pauses between its read and its write while you change
//   the value again. The write then carries an out-of-date compareDigest, and
//   Shopify must reject it. This is the path the GraphQL validator can't
//   check, because compareDigest travels in the variables.
//
// Both phases must end STALE with your edit still in Shopify. The test
// proposals are deleted afterwards. If the script ever writes, the value it
// writes ends in "[cg-stale-test]" so it's easy to spot and undo.
import { createInterface } from "node:readline/promises";

const shop = process.argv[2] ?? process.env.SHOP;
if (!shop) {
  console.error("Usage: npm run test:stale -- <shop>.myshopify.com");
  process.exit(1);
}

// Same reason as scripts/run-scan.js: shopify.server.js needs a URL-shaped
// SHOPIFY_APP_URL to load, and unauthenticated.admin() never uses it.
process.env.SHOPIFY_APP_URL ??= "http://localhost:3000";

const { default: prisma } = await import("../app/db.server.js");
const { createScanRun, runScan } = await import("../app/services/scanEngine.server.js");
const { applyApprovedProposals, STALE_MESSAGE } = await import("../app/services/bulkFixEngine.server.js");
const { graphqlRequest } = await import("../app/services/shopifyGraphql.server.js");
const { GET_PRODUCT_METAFIELD } = await import("../app/graphql/getProductMetafield.js");
const { unauthenticated } = await import("../app/shopify.server.js");

const MARKER = " [cg-stale-test]";
const rl = createInterface({ input: process.stdin, output: process.stdout });
// Resolves false if stdin closes (Ctrl-D or a non-interactive run), so the
// script can clean up instead of hanging.
const waitForEnter = (prompt) =>
  new Promise((resolve) => {
    rl.once("close", () => resolve(false));
    rl.question(prompt).then(() => resolve(true), () => resolve(false));
  });

const createdIds = [];
let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
};

try {
  const { admin } = await unauthenticated.admin(shop);

  const readValue = async (target) => {
    const { data } = await graphqlRequest(
      admin,
      GET_PRODUCT_METAFIELD,
      { productId: target.productId, namespace: target.namespace, key: target.key },
      () => {},
    );
    return data.product?.metafield?.value ?? null;
  };

  const makeProposal = (target, originalValue, scanRunId) =>
    prisma.fixProposal.create({
      data: {
        shop,
        productId: target.productId,
        productTitle: target.productTitle,
        namespace: target.namespace,
        key: target.key,
        valueType: target.expectedType,
        ruleType: "NAMING",
        ruleDetail: "Stale-path test (scripts/test-stale-apply.js)",
        originalValue,
        proposedValue: `${originalValue}${MARKER}`,
        status: "APPROVED",
        scanRunId,
      },
    });

  console.log("Scanning…");
  const scanRun = await createScanRun(shop);
  await runScan({ admin, shop, scanRunId: scanRun.id });

  const target = await prisma.scanResult.findFirst({
    where: { shop, scanRunId: scanRun.id, status: "OK", expectedType: "single_line_text_field" },
    orderBy: { productTitle: "asc" },
  });
  if (!target) {
    throw new Error("No product has a single-line text metafield with a value. Add one in the admin and re-run.");
  }

  const original = target.actualValue;
  const numericId = target.productId.split("/").pop();
  console.log(`\nTest metafield: ${target.namespace}.${target.key} on "${target.productTitle}"`);
  console.log(`  Admin: https://${shop}/admin/products/${numericId}`);
  console.log(`  Current value: ${JSON.stringify(original)}`);

  // Phase A: edited before Apply.
  const a = await makeProposal(target, original, scanRun.id);
  createdIds.push(a.id);
  if (!(await waitForEnter("\nPhase A: change this metafield to any other value in the admin, save, then press Enter. ")))
    throw new Error("Stopped before phase A.");

  const [resultA] = await applyApprovedProposals({ admin, shop, proposalIds: [a.id] });
  const afterA = await readValue(target);
  console.log("\nPhase A (edited before Apply):");
  check("value was changed in the admin", afterA !== original, `Shopify now has ${JSON.stringify(afterA)}`);
  check("proposal ended STALE", resultA.outcome === "stale", `outcome=${resultA.outcome} error=${resultA.error}`);
  check("nothing was overwritten", afterA !== `${original}${MARKER}`);

  // Phase B: edited between the engine's read and its write.
  const b = await makeProposal(target, afterA, scanRun.id);
  createdIds.push(b.id);
  let pausedForEdit = false;
  const pausingAdmin = {
    graphql: async (query, options) => {
      const response = await admin.graphql(query, options);
      if (query.includes("GetProductMetafield") && !pausedForEdit) {
        pausedForEdit = true;
        if (!(await waitForEnter("\nPhase B: the engine has read the value. Change it AGAIN in the admin, save, then press Enter. ")))
          throw new Error("Stopped during phase B.");
      }
      return response;
    },
  };

  const [resultB] = await applyApprovedProposals({ admin: pausingAdmin, shop, proposalIds: [b.id] });
  const afterB = await readValue(target);
  console.log("\nPhase B (edited between read and write):");
  check("value was changed again in the admin", afterB !== afterA, `Shopify now has ${JSON.stringify(afterB)}`);
  check("proposal ended STALE", resultB.outcome === "stale", `outcome=${resultB.outcome} error=${resultB.error}`);
  // The re-read passed in this phase, so a STALE here must come from
  // Shopify rejecting the compareDigest, which appends its own message.
  check(
    "STALE came from Shopify's compareDigest check",
    resultB.outcome === "stale" && resultB.error !== STALE_MESSAGE,
    resultB.error,
  );
  check("nothing was overwritten", afterB !== `${afterA}${MARKER}`);

  console.log(`\nTo restore the field, set it back to ${JSON.stringify(original)} in the admin.`);
} catch (error) {
  failures++;
  console.error(`\nTest stopped: ${error.message}`);
} finally {
  rl.close();
  await prisma.fixProposal.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll stale-path checks passed." : `\n${failures} check(s) failed.`);
if (failures > 0) process.exitCode = 1;
