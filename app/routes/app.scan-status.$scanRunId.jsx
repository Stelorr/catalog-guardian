import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { expireStaleScanRuns } from "../services/scanEngine.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  // Without this, a page already polling a scan that died with the server
  // would show "Scanning…" until a reload.
  await expireStaleScanRuns(session.shop);

  // Scope to session.shop so one shop can never poll another shop's scan,
  // even though a cuid scanRunId isn't realistically guessable.
  const scanRun = await prisma.scanRun.findFirst({
    where: { id: params.scanRunId, shop: session.shop },
  });

  if (!scanRun) {
    throw new Response("Not found", { status: 404 });
  }

  const breakdown = await prisma.scanResult.groupBy({
    by: ["status"],
    where: { scanRunId: scanRun.id },
    _count: { status: true },
  });

  return {
    scanRun: {
      id: scanRun.id,
      status: scanRun.status,
      startedAt: scanRun.startedAt,
      completedAt: scanRun.completedAt,
      errorMessage: scanRun.errorMessage,
      totalProductsScanned: scanRun.totalProductsScanned,
      totalIssuesFound: scanRun.totalIssuesFound,
    },
    pendingProposals: await prisma.fixProposal.count({
      where: { shop: session.shop, status: "PENDING" },
    }),
    breakdown: breakdown.map((row) => ({
      status: row.status,
      count: row._count.status,
    })),
  };
};
