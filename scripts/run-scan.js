const shop = process.argv[2] ?? process.env.SHOP;

if (!shop) {
  console.error(
    "Usage: node --env-file=.env scripts/run-scan.js <shop>.myshopify.com",
  );
  process.exit(1);
}

// shopify.server.js requires a syntactically valid SHOPIFY_APP_URL to
// construct at all, but `shopify app dev` only ever injects the real tunnel
// URL into its own child process env — it's never written to .env or
// shopify.app.toml, so a standalone script can't recover it.
// unauthenticated.admin() (the only thing this script calls) authenticates
// with the stored offline session's token directly against the shop's API
// and never touches appUrl/hostName, so the value is unused here — only
// valid-URL-shaped. Imports are dynamic so this line runs before
// shopify.server.js is loaded.
process.env.SHOPIFY_APP_URL ??= "http://localhost:3000";

const { default: prisma } = await import("../app/db.server.js");
const { createScanRun, runScan } = await import(
  "../app/services/scanEngine.server.js"
);
const { unauthenticated } = await import("../app/shopify.server.js");

const startedAt = Date.now();

try {
  const { admin } = await unauthenticated.admin(shop);
  const scanRun = await createScanRun(shop);
  const summary = await runScan({
    admin,
    shop,
    scanRunId: scanRun.id,
    log: (line) => console.log(line),
  });

  console.log("\nScan complete");
  console.log(`  scan run:  ${summary.scanRunId}`);
  console.log(`  products:  ${summary.totalProductsScanned}`);
  console.log(`  issues:    ${summary.totalIssuesFound}`);
  console.log(`  duration:  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const byStatus = await prisma.scanResult.groupBy({
    by: ["status"],
    where: { scanRunId: summary.scanRunId },
    _count: { status: true },
  });
  for (const row of byStatus) {
    console.log(`  ${row.status}: ${row._count.status}`);
  }
} catch (error) {
  console.error("\nScan failed:", error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
