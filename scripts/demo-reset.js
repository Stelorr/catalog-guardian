// Puts the demo back to its starting state on a development store:
//
//   npm run demo:reset -- <shop>.myshopify.com
//   npm run demo:reset -- <shop>.myshopify.com --dry-run   check the store, change nothing
//
// 1. Re-runs the seed, which resets every cg_demo value to its messy state
//    (undoing any fix you applied during the demo).
// 2. Deletes this shop's FixProposal rows, including decided ones, so
//    nothing approved or rejected earlier survives.
// 3. Runs a scan, which regenerates the proposals.
//
// It refuses any store Shopify doesn't report as a partner development
// store, and requires the shop to be named. The seed goes first so a failure
// there leaves your existing proposals alone.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const shop = args.find((arg) => !arg.startsWith("--"));

if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  console.error("Usage: npm run demo:reset -- <shop>.myshopify.com [--dry-run]");
  process.exit(1);
}

// Same reason as scripts/run-scan.js: shopify.server.js needs a URL-shaped
// SHOPIFY_APP_URL to load, and unauthenticated.admin() never uses it.
process.env.SHOPIFY_APP_URL ??= "http://localhost:3000";

const { default: prisma } = await import("../app/db.server.js");
const { unauthenticated } = await import("../app/shopify.server.js");
const { graphqlRequest } = await import("../app/services/shopifyGraphql.server.js");
const { GET_SHOP_PLAN } = await import("../app/graphql/getShopPlan.js");

// Runs a sibling script with the same Node and env file, streaming its output.
function runScript(name) {
  const result = spawnSync(
    process.execPath,
    ["--env-file=.env", fileURLToPath(new URL(name, import.meta.url)), shop],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`${name} failed (exit ${result.status}).`);
}

try {
  const { admin } = await unauthenticated.admin(shop);
  const { data } = await graphqlRequest(admin, GET_SHOP_PLAN, {}, () => {});
  if (data.shop.plan?.partnerDevelopment !== true) {
    throw new Error(`${shop} is not a development store, so demo:reset won't touch it.`);
  }
  console.log(`${shop} is a development store.`);

  const proposalCount = await prisma.fixProposal.count({ where: { shop } });
  if (dryRun) {
    console.log("\nDry run. A real run would:");
    console.log("  1. re-run the seed (resets the 20 seed products to their messy values)");
    console.log(`  2. delete ${proposalCount} FixProposal row(s) for this shop`);
    console.log("  3. run a scan, which regenerates the proposals");
    process.exit(0);
  }

  console.log("\n[1/3] Resetting the seed catalog");
  runScript("seed-messy-catalog.js");

  console.log("\n[2/3] Deleting FixProposal rows");
  const { count } = await prisma.fixProposal.deleteMany({ where: { shop } });
  console.log(`Deleted ${count} row(s).`);

  console.log("\n[3/3] Scanning");
  runScript("run-scan.js");

  console.log("\nDemo reset. Open Review to see the regenerated proposals.");
} catch (error) {
  console.error(`\nDemo reset stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
