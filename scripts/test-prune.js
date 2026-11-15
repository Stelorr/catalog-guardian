// Checks that a completed scan prunes stale results, and that nothing else
// ever does. Runs the real runScan against a fake Shopify admin and two
// throwaway shops in the local dev database (cleaned up afterwards), so it
// needs `npm run setup` to have been run but no Shopify access.
import { createScanRun, pruneStaleResults, runScan } from "../app/services/scanEngine.server.js";
import prisma from "../app/db.server.js";

const SHOP = "test-prune.myshopify.com";
const OTHER_SHOP = "test-prune-other.myshopify.com";
const ago = (ms) => new Date(Date.now() - ms);
const HOUR = 60 * 60 * 1000;
const cost = { requestedQueryCost: 1, throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } };

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${!pass && detail ? `\n        ${detail}` : ""}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function reset() {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.fixProposal.deleteMany({ where: { shop } });
    await prisma.scanRun.deleteMany({ where: { shop } }); // cascades to ScanResult
  }
}

const gid = (n) => `gid://shopify/Product/${n}`;
const label = (productId, key) => `P${productId.split("/").pop()}/${key}`;

async function addResult(shop, scanRunId, n, key, lastCheckedAt) {
  return prisma.scanResult.create({
    data: {
      shop, scanRunId, productId: gid(n), productTitle: `P${n}`, namespace: "custom", key,
      expectedType: "single_line_text_field", actualValue: "v", status: "OK", lastCheckedAt,
    },
  });
}

async function addProposal(shop, scanRunId, n, key, status) {
  return prisma.fixProposal.create({
    data: {
      shop, scanRunId, productId: gid(n), productTitle: `P${n}`, namespace: "custom", key,
      valueType: "single_line_text_field", ruleType: "CASING", ruleDetail: "test",
      originalValue: "v", proposedValue: "V", status,
    },
  });
}

// An earlier COMPLETE scan: products 1-3, definitions "a" and "old". Since
// then product 3 was deleted and definition "old" was removed.
async function seedEarlierScan() {
  await reset();
  const earlier = await prisma.scanRun.create({
    data: { shop: SHOP, status: "COMPLETE", startedAt: ago(HOUR), completedAt: ago(HOUR) },
  });
  for (const n of [1, 2, 3]) for (const key of ["a", "old"]) await addResult(SHOP, earlier.id, n, key, ago(HOUR));
  await addProposal(SHOP, earlier.id, 3, "a", "PENDING");   // product deleted
  await addProposal(SHOP, earlier.id, 1, "old", "PENDING"); // definition removed
  await addProposal(SHOP, earlier.id, 1, "old", "APPLIED"); // decided: must survive
  await addProposal(SHOP, earlier.id, 3, "a", "REJECTED");  // decided: must survive

  const otherRun = await prisma.scanRun.create({
    data: { shop: OTHER_SHOP, status: "COMPLETE", startedAt: ago(HOUR), completedAt: ago(HOUR) },
  });
  await addResult(OTHER_SHOP, otherRun.id, 9, "old", ago(HOUR));
  await addProposal(OTHER_SHOP, otherRun.id, 9, "old", "PENDING");
}

async function snapshot(shop = SHOP) {
  const results = await prisma.scanResult.findMany({ where: { shop } });
  const proposals = await prisma.fixProposal.findMany({ where: { shop } });
  return {
    results: results.map((r) => label(r.productId, r.key)).sort(),
    proposals: proposals.map((p) => `${p.status} ${label(p.productId, p.key)}`).sort(),
  };
}

// definitions: [key]; pages: [[{ n, a }]]; failOnProductPage: 1-based page
// that throws; failOnDefinitions: throw immediately.
function fakeAdmin({ definitions, pages, failOnProductPage, failOnDefinitions }) {
  let productCalls = 0;
  const reply = (data) => ({ json: async () => ({ data, extensions: { cost } }) });
  return {
    graphql: async (query) => {
      if (query.includes("GetMetafieldDefinitions")) {
        if (failOnDefinitions) throw new Error("simulated outage");
        return reply({
          metafieldDefinitions: {
            nodes: definitions.map((key) => ({
              namespace: "custom", key, description: null, type: { name: "single_line_text_field" },
            })),
            pageInfo: { hasNextPage: false },
          },
        });
      }
      productCalls++;
      if (productCalls === failOnProductPage) throw new Error("simulated outage");
      const page = pages[productCalls - 1];
      return reply({
        products: {
          nodes: page.map(({ n, a }) => ({
            id: gid(n),
            title: `P${n}`,
            metafields: {
              nodes: a ? [{ namespace: "custom", key: "a", value: a, type: "single_line_text_field" }] : [],
              pageInfo: { hasNextPage: false },
            },
          })),
          pageInfo: { hasNextPage: productCalls < pages.length, endCursor: `c${productCalls}` },
        },
      });
    },
  };
}

async function scan(options) {
  const run = await createScanRun(SHOP);
  let error = null;
  try {
    await runScan({ admin: fakeAdmin(options), shop: SHOP, scanRunId: run.id });
  } catch (e) {
    error = e;
  }
  return { run: await prisma.scanRun.findUnique({ where: { id: run.id } }), error };
}

try {
  console.log("\nCompleted scan: stale definition and deleted product are pruned");
  await seedEarlierScan();
  const otherBefore = await snapshot(OTHER_SHOP);
  let { run, error } = await scan({ definitions: ["a"], pages: [[{ n: 1, a: "x" }, { n: 2 }]] });
  let after = await snapshot();
  check("scan completed cleanly", !error && run.status === "COMPLETE" && run.errorMessage === null, `${run.status} ${run.errorMessage}`);
  check("only rows from this scan remain (removed definition and deleted product are gone)",
    same(after.results, ["P1/a", "P2/a"]), JSON.stringify(after.results));
  // generateProposals also clears PENDING rows, so the orphan-specific check is in the direct test below.
  check("decided proposals survive, even on removed rows",
    same(after.proposals, ["APPLIED P1/old", "REJECTED P3/a"]), JSON.stringify(after.proposals));
  check("another shop's results and proposals are untouched",
    same(await snapshot(OTHER_SHOP), otherBefore), JSON.stringify(await snapshot(OTHER_SHOP)));

  console.log("\nFailed scan: nothing is deleted");
  await seedEarlierScan();
  const before = await snapshot();
  ({ run, error } = await scan({ definitions: ["a"], pages: [[{ n: 1, a: "x" }], [{ n: 2 }]], failOnProductPage: 2 }));
  check("scan failed partway, after page 1 was saved", Boolean(error) && run.status === "FAILED" && /saving|fetching/.test(run.errorMessage ?? ""), `${run.status} ${run.errorMessage}`);
  check("every earlier result and proposal is still there", same(await snapshot(), before), JSON.stringify(await snapshot()));

  await seedEarlierScan();
  const before2 = await snapshot();
  ({ run, error } = await scan({ definitions: ["a"], pages: [[]], failOnDefinitions: true }));
  check("a scan that fails before reading any product also deletes nothing", Boolean(error) && run.status === "FAILED" && same(await snapshot(), before2));

  console.log("\nCompleted scan with no definitions: every result is stale");
  await seedEarlierScan();
  const otherBefore2 = await snapshot(OTHER_SHOP);
  ({ run, error } = await scan({ definitions: [], pages: [[]] }));
  after = await snapshot();
  check("all of the shop's results are pruned", !error && run.status === "COMPLETE" && after.results.length === 0, JSON.stringify(after.results));
  check("decided proposals still survive", same(after.proposals, ["APPLIED P1/old", "REJECTED P3/a"]), JSON.stringify(after.proposals));
  check("another shop is untouched", same(await snapshot(OTHER_SHOP), otherBefore2));

  console.log("\npruneStaleResults directly");
  await reset();
  const earlier = await prisma.scanRun.create({ data: { shop: SHOP, status: "COMPLETE", startedAt: ago(HOUR), completedAt: ago(HOUR) } });
  const current = await prisma.scanRun.create({ data: { shop: SHOP, status: "RUNNING", startedAt: ago(10 * 60 * 1000) } });
  const newer = await prisma.scanRun.create({ data: { shop: SHOP, status: "RUNNING" } }); // started after `current`
  await addResult(SHOP, current.id, 1, "a", new Date());   // touched by the scan being pruned for
  await addResult(SHOP, earlier.id, 2, "a", ago(HOUR));    // stale
  await addResult(SHOP, newer.id, 3, "a", new Date());     // written by a newer scan still running
  await addProposal(SHOP, earlier.id, 1, "a", "PENDING");  // row exists: keep
  await addProposal(SHOP, earlier.id, 2, "a", "PENDING");  // row pruned: orphan, delete
  await addProposal(SHOP, earlier.id, 2, "a", "REJECTED"); // decided: keep
  await addProposal(SHOP, earlier.id, 2, "a", "APPLIED");  // decided: keep
  const counts = await pruneStaleResults({ shop: SHOP, scanRunId: current.id });
  after = await snapshot();
  check("deletes only the stale row", counts.results === 1 && same(after.results, ["P1/a", "P3/a"]), `${JSON.stringify(counts)} ${JSON.stringify(after.results)}`);
  check("keeps a newer scan's rows (late finish of an expired scan)", after.results.includes("P3/a"));
  check("deletes only the PENDING proposal that lost its row", counts.proposals === 1 && same(after.proposals, ["APPLIED P2/a", "PENDING P1/a", "REJECTED P2/a"]), JSON.stringify(after.proposals));
  const again = await pruneStaleResults({ shop: SHOP, scanRunId: current.id });
  check("running it again deletes nothing", again.results === 0 && again.proposals === 0, JSON.stringify(again));
} finally {
  await reset();
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll prune checks passed." : `\n${failures} check(s) failed.`);
if (failures > 0) process.exitCode = 1;
