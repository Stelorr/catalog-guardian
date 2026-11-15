import prisma from "../db.server.js";
import { GET_METAFIELD_DEFINITIONS } from "../graphql/getMetafieldDefinitions.js";
import { GET_PRODUCT_METAFIELDS } from "../graphql/getProductMetafields.js";
import { GET_PRODUCTS_WITH_METAFIELDS } from "../graphql/getProductsWithMetafields.js";
import { generateProposals } from "./fixProposals.server.js";
import { graphqlRequest, pauseForCapacity } from "./shopifyGraphql.server.js";

// Page sizes are kept small enough that requested query cost stays well under
// Shopify's hard 1000-point-per-query ceiling: roughly 2 + products * (3 + metafields).
const PRODUCT_PAGE_SIZE = 15;
const METAFIELDS_PER_PRODUCT = 40;
const DEFINITIONS_PAGE_SIZE = 100;
const WRITE_BATCH_SIZE = 100;

async function fetchMetafieldDefinitions(admin, log) {
  const definitions = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const { data, cost } = await graphqlRequest(
      admin,
      GET_METAFIELD_DEFINITIONS,
      { ownerType: "PRODUCT", first: DEFINITIONS_PAGE_SIZE, after },
      log,
    );
    const connection = data.metafieldDefinitions;
    definitions.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
    await pauseForCapacity(cost, log);
  }

  return definitions;
}

async function fetchRemainingMetafields(admin, productId, startCursor, log) {
  const metafields = [];
  let after = startCursor;
  let hasNextPage = true;

  while (hasNextPage) {
    const { data, cost } = await graphqlRequest(
      admin,
      GET_PRODUCT_METAFIELDS,
      { productId, first: METAFIELDS_PER_PRODUCT, after },
      log,
    );
    const connection = data.product?.metafields;
    if (!connection) break;
    metafields.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
    await pauseForCapacity(cost, log);
  }

  return metafields;
}

// Returns true/false, or null when the type is one we can't meaningfully
// verify locally and we trust Shopify's own write-time validation.
function valueMatchesType(value, typeName) {
  const trimmed = value.trim();

  if (typeName.startsWith("list.")) {
    try {
      return Array.isArray(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }

  switch (typeName) {
    case "number_integer":
      return /^-?\d+$/.test(trimmed);
    case "number_decimal":
      return /^-?\d+(\.\d+)?$/.test(trimmed);
    case "boolean":
      return trimmed === "true" || trimmed === "false";
    case "json":
    case "money":
    case "rating":
    case "dimension":
    case "volume":
    case "weight":
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    case "date_time":
      return !Number.isNaN(Date.parse(trimmed));
    case "url":
      try {
        new URL(trimmed);
        return true;
      } catch {
        return false;
      }
    default:
      return null;
  }
}

// A list or JSON value that parses to [] or {} carries no actual content,
// even though Shopify's write-time validation happily accepts it as "present".
function isEmptyCollection(value, typeName) {
  if (typeName !== "json" && !typeName.startsWith("list.")) return false;

  let parsed;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return false;
  }

  if (Array.isArray(parsed)) return parsed.length === 0;
  if (parsed !== null && typeof parsed === "object") {
    return Object.keys(parsed).length === 0;
  }
  return false;
}

export function classifyMetafield(definition, metafield) {
  if (!metafield || metafield.value == null) {
    return { status: "MISSING", actualValue: null };
  }

  const { value } = metafield;
  if (value.trim() === "") {
    return { status: "EMPTY", actualValue: value };
  }

  const expectedType = definition.type.name;
  if (metafield.type !== expectedType) {
    return { status: "TYPE_MISMATCH", actualValue: value };
  }
  if (valueMatchesType(value, expectedType) === false) {
    return { status: "TYPE_MISMATCH", actualValue: value };
  }
  if (isEmptyCollection(value, expectedType)) {
    return { status: "EMPTY", actualValue: value };
  }

  return { status: "OK", actualValue: value };
}

async function writeResults(rows) {
  for (let i = 0; i < rows.length; i += WRITE_BATCH_SIZE) {
    const chunk = rows.slice(i, i + WRITE_BATCH_SIZE);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.scanResult.upsert({
          where: {
            shop_productId_namespace_key: {
              shop: row.shop,
              productId: row.productId,
              namespace: row.namespace,
              key: row.key,
            },
          },
          create: row,
          update: {
            productTitle: row.productTitle,
            expectedType: row.expectedType,
            description: row.description,
            actualValue: row.actualValue,
            status: row.status,
            lastCheckedAt: row.lastCheckedAt,
            scanRunId: row.scanRunId,
            // Recomputed by generateProposals once the scan completes.
            flagReason: null,
          },
        }),
      ),
    );
  }
}

// Split from runScan so a caller that needs the id before the scan finishes
// (e.g. to respond to an HTTP request immediately and run the scan in the
// background) can create the row synchronously first.
export async function createScanRun(shop) {
  return prisma.scanRun.create({ data: { shop, status: "RUNNING" } });
}

const STALE_SCAN_MS = 5 * 60 * 1000;

// A scan runs in-process, so a server restart leaves its row RUNNING forever
// and blocks every new scan. Anything RUNNING past the cutoff is marked
// FAILED instead. Call before reading RUNNING rows.
// ponytail: fixed cutoff from startedAt, so a legitimately slower scan is
// failed early (it still flips to COMPLETE if it finishes); a heartbeat
// column would fix that if catalogs get big enough to need it.
export async function expireStaleScanRuns(shop) {
  return prisma.scanRun.updateMany({
    where: {
      shop,
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - STALE_SCAN_MS) },
    },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      errorMessage: "Scan did not finish within 5 minutes (server restarted or scan timed out).",
    },
  });
}

const MAX_ERROR_LENGTH = 2000;

// The message plus the top few stack frames: enough to locate a failure on
// the ScanRun row without storing a whole trace.
function describeError(error) {
  const frames = (error?.stack ?? "")
    .split("\n")
    .filter((line) => line.trim().startsWith("at "))
    .slice(0, 4);
  return [error?.message ?? String(error), ...frames].join("\n").slice(0, MAX_ERROR_LENGTH);
}

// Deletes this shop's results that a completed scan didn't touch: they belong
// to products or metafield definitions that no longer exist, and would
// otherwise sit in the Issues list forever. Call only after a scan has
// processed everything; a partial scan would delete rows it just hadn't
// reached yet.
//
// Rows are matched by scanRunId (every scan rewrites it on each row it
// sees). The lastCheckedAt cutoff protects a newer scan running at the same
// time, e.g. when this one was expired as stale but finished late: its rows
// were checked after this run started, so they're kept.
//
// PENDING proposals left without a result row are deleted in the same
// transaction. Decided proposals (approved, rejected, applied, failed,
// stale) are never touched. The proposals delete is raw SQL because Prisma
// can't delete by a join.
export async function pruneStaleResults({ shop, scanRunId }) {
  const run = await prisma.scanRun.findUniqueOrThrow({
    where: { id: scanRunId },
    select: { startedAt: true },
  });

  const [results, proposals] = await prisma.$transaction([
    prisma.scanResult.deleteMany({
      where: {
        shop,
        scanRunId: { not: scanRunId },
        lastCheckedAt: { lt: run.startedAt },
      },
    }),
    prisma.$executeRaw`
      DELETE FROM "FixProposal"
      WHERE "shop" = ${shop} AND "status" = 'PENDING' AND NOT EXISTS (
        SELECT 1 FROM "ScanResult" s
        WHERE s."shop" = "FixProposal"."shop"
          AND s."productId" = "FixProposal"."productId"
          AND s."namespace" = "FixProposal"."namespace"
          AND s."key" = "FixProposal"."key"
      )`,
  ]);

  return { results: results.count, proposals };
}

export async function runScan({ admin, shop, scanRunId, log = () => {} }) {
  let totalProductsScanned = 0;
  let totalIssuesFound = 0;
  // Which step was running, so a recorded failure says where it happened.
  let stage = "fetching metafield definitions";

  try {
    const definitions = await fetchMetafieldDefinitions(admin, log);
    log(`Found ${definitions.length} product metafield definition(s)`);

    if (definitions.length > 0) {
      let after = null;
      let hasNextPage = true;
      let pageNumber = 0;

      while (hasNextPage) {
        pageNumber++;
        stage = `fetching products page ${pageNumber}`;
        const { data, cost } = await graphqlRequest(
          admin,
          GET_PRODUCTS_WITH_METAFIELDS,
          {
            first: PRODUCT_PAGE_SIZE,
            after,
            metafieldsFirst: METAFIELDS_PER_PRODUCT,
          },
          log,
        );

        const connection = data.products;
        const checkedAt = new Date();
        const rows = [];
        // Counted per page and only added to the run totals once the page is
        // saved, so the totals reflect what was actually persisted.
        let pageProducts = 0;
        let pageIssues = 0;

        for (const product of connection.nodes) {
          const metafields = [...product.metafields.nodes];
          if (product.metafields.pageInfo.hasNextPage) {
            metafields.push(
              ...(await fetchRemainingMetafields(
                admin,
                product.id,
                product.metafields.pageInfo.endCursor,
                log,
              )),
            );
          }

          const byKey = new Map(
            metafields.map((metafield) => [
              `${metafield.namespace}.${metafield.key}`,
              metafield,
            ]),
          );

          for (const definition of definitions) {
            const { status, actualValue } = classifyMetafield(
              definition,
              byKey.get(`${definition.namespace}.${definition.key}`),
            );
            if (status !== "OK") pageIssues++;

            rows.push({
              shop,
              productId: product.id,
              productTitle: product.title,
              namespace: definition.namespace,
              key: definition.key,
              expectedType: definition.type.name,
              description: definition.description,
              actualValue,
              status,
              lastCheckedAt: checkedAt,
              scanRunId,
            });
          }

          pageProducts++;
        }

        stage = `saving results for products page ${pageNumber}`;
        await writeResults(rows);
        totalProductsScanned += pageProducts;
        totalIssuesFound += pageIssues;
        log(`Scanned ${totalProductsScanned} product(s), ${totalIssuesFound} issue(s) so far`);

        hasNextPage = connection.pageInfo.hasNextPage;
        after = connection.pageInfo.endCursor;
        await pauseForCapacity(cost, log);
      }
    }

    // Pruning and proposal generation only run after a complete scan: with
    // partial data, pruning would delete rows the scan hadn't reached and
    // proposals would be built on skewed majorities. A failure in either
    // doesn't undo a good scan, so it's recorded on the run while the run
    // stays COMPLETE.
    const warnings = [];
    try {
      const pruned = await pruneStaleResults({ shop, scanRunId });
      log(`Pruned ${pruned.results} stale result(s) and ${pruned.proposals} orphaned proposal(s)`);
    } catch (error) {
      warnings.push(`[pruning stale results] ${describeError(error)}`);
      log(`Pruning stale results failed: ${error.message}`);
    }
    try {
      const generated = await generateProposals({ shop, scanRunId });
      log(`Generated ${generated.proposals} fix proposal(s) and ${generated.flags} flag(s)`);
    } catch (error) {
      warnings.push(`[generating proposals] ${describeError(error)}`);
      log(`Generating proposals failed: ${error.message}`);
    }

    await prisma.scanRun.update({
      where: { id: scanRunId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        totalProductsScanned,
        totalIssuesFound,
        errorMessage: warnings.length > 0 ? warnings.join("\n").slice(0, MAX_ERROR_LENGTH) : null,
      },
    });

    return { scanRunId, totalProductsScanned, totalIssuesFound };
  } catch (error) {
    await prisma.scanRun.update({
      where: { id: scanRunId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        totalProductsScanned,
        totalIssuesFound,
        errorMessage: `[${stage}] ${describeError(error)}`.slice(0, MAX_ERROR_LENGTH),
      },
    });
    throw error;
  }
}
