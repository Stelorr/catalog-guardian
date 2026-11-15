import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createScanRun,
  expireStaleScanRuns,
  runScan,
} from "../services/scanEngine.server";

const STATUS_ORDER = ["MISSING", "EMPTY", "TYPE_MISMATCH", "OK"];
const STATUS_TONE = {
  MISSING: "critical",
  EMPTY: "warning",
  TYPE_MISMATCH: "caution",
  OK: "success",
};
const POLL_INTERVAL_MS = 2000;
const ERROR_PREVIEW_LENGTH = 400;

// The saved errorMessage is "[stage] message" followed by a few stack
// frames. Only the part before the first frame is useful here, and frames
// would expose server file paths in the UI; the full text stays on the run.
function describeScanError(errorMessage) {
  const message = errorMessage.split(/\n\s+at /)[0].trim();
  return message.length > ERROR_PREVIEW_LENGTH
    ? `${message.slice(0, ERROR_PREVIEW_LENGTH)}…`
    : message;
}

function toBreakdownRows(breakdown) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const row of breakdown) {
    counts[row.status] = row.count;
  }
  return STATUS_ORDER.map((status) => ({ status, count: counts[status] }));
}

async function loadLastCompletedScan(shop) {
  const lastRun = await prisma.scanRun.findFirst({
    where: { shop, status: { in: ["COMPLETE", "FAILED"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!lastRun) return null;

  const breakdown = await prisma.scanResult.groupBy({
    by: ["status"],
    where: { scanRunId: lastRun.id },
    _count: { status: true },
  });

  return {
    id: lastRun.id,
    status: lastRun.status,
    startedAt: lastRun.startedAt,
    completedAt: lastRun.completedAt,
    errorMessage: lastRun.errorMessage,
    totalProductsScanned: lastRun.totalProductsScanned,
    totalIssuesFound: lastRun.totalIssuesFound,
    breakdown: breakdown.map((row) => ({
      status: row.status,
      count: row._count.status,
    })),
  };
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  await expireStaleScanRuns(shop);

  // Resuming an in-flight scan (rather than forgetting about it on reload)
  // also prevents a page refresh from letting the merchant start a second,
  // overlapping scan for the same shop.
  const activeRun = await prisma.scanRun.findFirst({
    where: { shop, status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });

  const pendingProposals = await prisma.fixProposal.count({
    where: { shop, status: "PENDING" },
  });

  if (activeRun) {
    return { activeScanRunId: activeRun.id, lastCompletedScan: null, pendingProposals };
  }

  return {
    activeScanRunId: null,
    lastCompletedScan: await loadLastCompletedScan(shop),
    pendingProposals,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;

  await expireStaleScanRuns(shop);

  const existingRun = await prisma.scanRun.findFirst({
    where: { shop, status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });
  if (existingRun) {
    return { scanRunId: existingRun.id };
  }

  const scanRun = await createScanRun(shop);

  // Fire-and-forget: this runs in a persistent Node container (see
  // Dockerfile), so the scan keeps going after this action's response is
  // sent — the page polls /app/scan-status/:id for progress instead of
  // blocking this request, since a full scan can take minutes on a large
  // catalog. A process restart mid-scan would leave this ScanRun stuck at
  // RUNNING; there's no job queue to reconcile that yet, an accepted gap.
  runScan({ admin, shop, scanRunId: scanRun.id }).catch((error) => {
    console.error(`Scan ${scanRun.id} failed`, error);
  });

  return { scanRunId: scanRun.id };
};

export default function Index() {
  const { activeScanRunId, lastCompletedScan, pendingProposals: loadedPendingProposals } =
    useLoaderData();
  const startFetcher = useFetcher();
  const statusFetcher = useFetcher();
  const [scanRunId, setScanRunId] = useState(activeScanRunId);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    if (startFetcher.data?.scanRunId) {
      setScanRunId(startFetcher.data.scanRunId);
    }
  }, [startFetcher.data]);

  // Only trust statusFetcher.data once it actually belongs to the current
  // scanRunId — right after starting a new scan, it still holds the
  // previous run's COMPLETE response, which would otherwise make isRunning
  // false immediately and stop the poller from ever checking the new run.
  const latestStatus =
    statusFetcher.data?.scanRun?.id === scanRunId
      ? statusFetcher.data.scanRun.status
      : undefined;
  const isRunning =
    Boolean(scanRunId) && latestStatus !== "COMPLETE" && latestStatus !== "FAILED";

  useEffect(() => {
    if (!scanRunId || !isRunning) return undefined;

    const poll = () => statusFetcher.load(`/app/scan-status/${scanRunId}`);
    poll();
    pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => clearInterval(pollTimerRef.current);
    // statusFetcher is intentionally omitted: it's stable across renders in
    // React Router, and including it would re-create the interval on every
    // poll response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRunId, isRunning]);

  const isStarting = startFetcher.state !== "idle";
  const summary = statusFetcher.data?.scanRun ?? lastCompletedScan;
  // A finished scan regenerates proposals, so prefer the count the poll
  // returned over the one loaded with the page.
  const pendingProposals = statusFetcher.data?.pendingProposals ?? loadedPendingProposals;
  const finishedAt = summary ? new Date(summary.completedAt ?? summary.startedAt) : null;
  const breakdown = toBreakdownRows(
    statusFetcher.data?.breakdown ?? lastCompletedScan?.breakdown ?? [],
  );

  return (
    <s-page heading="Catalog Guardian">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => startFetcher.submit({}, { method: "POST" })}
        disabled={isRunning || isStarting}
        {...(isRunning || isStarting ? { loading: true } : {})}
      >
        Run Scan
      </s-button>

      <s-section heading="Scan status">
        {isRunning ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Scan in progress" size="base" />
            <s-text>
              {statusFetcher.data?.scanRun
                ? `Scanning products — ${statusFetcher.data.scanRun.totalProductsScanned} scanned so far`
                : "Starting scan…"}
            </s-text>
          </s-stack>
        ) : summary ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={summary.status === "FAILED" ? "critical" : "success"}>
              {summary.status === "FAILED" ? "Failed" : "Complete"}
            </s-badge>
            <s-text color="subdued">Last scan: {finishedAt.toLocaleString()}</s-text>
          </s-stack>
        ) : (
          <s-paragraph>No scans have been run yet.</s-paragraph>
        )}

        {!isRunning && summary?.errorMessage && (
          <s-banner
            tone={summary.status === "FAILED" ? "critical" : "warning"}
            heading={
              summary.status === "FAILED"
                ? "The last scan failed"
                : "The scan finished, but fix proposals couldn't be generated"
            }
          >
            <s-paragraph>{describeScanError(summary.errorMessage)}</s-paragraph>
          </s-banner>
        )}
      </s-section>

      {summary && !isRunning && (
        <s-section heading="Scan summary">
          <s-stack direction="inline" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-text color="subdued">Products scanned</s-text>
                <s-heading>{summary.totalProductsScanned}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-text color="subdued">Issues found</s-text>
                <s-heading>{summary.totalIssuesFound}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-text color="subdued">Pending fix proposals</s-text>
                <s-heading>{pendingProposals}</s-heading>
                {pendingProposals > 0 && <s-link href="/app/review">Review fixes</s-link>}
              </s-stack>
            </s-box>
          </s-stack>

          <s-table>
            <s-table-header-row>
              <s-table-header>Status</s-table-header>
              <s-table-header>Count</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {breakdown.map((row) => (
                <s-table-row key={row.status}>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[row.status]}>{row.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{row.count}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
