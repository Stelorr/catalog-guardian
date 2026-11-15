import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyApprovedProposals } from "../services/bulkFixEngine.server";
import { describeFix, formatMetafieldValue } from "../utils/formatMetafieldValue";

// Rows shown per section. "Approve all" sends exactly the visible ids, so it
// never approves a proposal the merchant can't see.
const ROW_LIMIT = 200;
const OPEN_STATUSES = ["PENDING", "APPROVED"];
const RULE_LABEL = { UNIT: "Unit", CASING: "Casing", NAMING: "Naming" };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const openWhere = { shop, status: { in: OPEN_STATUSES } };
  const flaggedWhere = { shop, status: "OK", flagReason: { not: null } };

  const [proposals, openCount, approvedCount, flagged, flaggedCount] = await Promise.all([
    prisma.fixProposal.findMany({
      where: openWhere,
      orderBy: [{ namespace: "asc" }, { key: "asc" }, { productTitle: "asc" }],
      take: ROW_LIMIT,
    }),
    prisma.fixProposal.count({ where: openWhere }),
    prisma.fixProposal.count({ where: { shop, status: "APPROVED" } }),
    prisma.scanResult.findMany({
      where: flaggedWhere,
      orderBy: [{ namespace: "asc" }, { key: "asc" }, { productTitle: "asc" }],
      take: ROW_LIMIT,
    }),
    prisma.scanResult.count({ where: flaggedWhere }),
  ]);

  return { proposals, openCount, approvedCount, flagged, flaggedCount, shop };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const ids = formData.getAll("proposalId");

  // Status filters make every update a no-op on rows already decided
  // elsewhere (another tab, a re-scan), instead of overwriting them.
  if (intent === "approve") {
    await prisma.fixProposal.updateMany({
      where: { id: { in: ids }, shop, status: "PENDING" },
      data: { status: "APPROVED", decidedAt: new Date() },
    });
    return { ok: true };
  }

  if (intent === "reject") {
    await prisma.fixProposal.updateMany({
      where: { id: { in: ids }, shop, status: { in: OPEN_STATUSES } },
      data: { status: "REJECTED", decidedAt: new Date() },
    });
    return { ok: true };
  }

  if (intent === "apply") {
    const approved = await prisma.fixProposal.findMany({
      where: { shop, status: "APPROVED" },
      select: { id: true },
    });
    try {
      const results = await applyApprovedProposals({
        admin,
        shop,
        proposalIds: approved.map((p) => p.id),
      });
      return { results };
    } catch (error) {
      return { error: error.message };
    }
  }

  return { error: "Unknown action." };
};

function adminProductUrl(shop, productGid) {
  const numericId = productGid.split("/").pop();
  return `https://${shop}/admin/products/${numericId}`;
}

function summarize(results) {
  const applied = results.filter((r) => r.outcome === "applied");
  const stale = results.filter((r) => r.outcome === "stale");
  const failed = results.filter((r) => r.outcome === "failed");
  return { applied, stale, failed };
}

export default function Review() {
  const { proposals, openCount, approvedCount, flagged, flaggedCount, shop } =
    useLoaderData();
  const shopify = useAppBridge();
  const decisionFetcher = useFetcher();
  const applyFetcher = useFetcher();

  const pending = proposals.filter((p) => p.status === "PENDING");
  const isDeciding = decisionFetcher.state !== "idle";
  const isApplying = applyFetcher.state !== "idle";

  useEffect(() => {
    if (decisionFetcher.data?.error) shopify.toast.show(decisionFetcher.data.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionFetcher.data]);

  useEffect(() => {
    if (applyFetcher.data?.error) shopify.toast.show(applyFetcher.data.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFetcher.data]);

  const decide = (intent, ids) => {
    const formData = new FormData();
    formData.append("intent", intent);
    for (const id of ids) formData.append("proposalId", id);
    decisionFetcher.submit(formData, { method: "POST" });
  };

  const applyApproved = () => {
    const formData = new FormData();
    formData.append("intent", "apply");
    applyFetcher.submit(formData, { method: "POST" });
  };

  const summary = applyFetcher.data?.results ? summarize(applyFetcher.data.results) : null;
  const hasAnything = openCount > 0 || flaggedCount > 0;

  return (
    <s-page heading="Review fixes">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={applyApproved}
        disabled={approvedCount === 0 || isApplying}
        {...(isApplying ? { loading: true } : {})}
      >
        Apply approved ({approvedCount})
      </s-button>

      {summary && (
        <s-banner
          tone={
            summary.failed.length > 0 ? "critical" : summary.stale.length > 0 ? "warning" : "success"
          }
          heading={`Applied ${summary.applied.length} of ${applyFetcher.data.results.length} fixes`}
        >
          {summary.applied.length > 0 && (
            <>
              <s-paragraph>
                <s-text type="strong">Applied ({summary.applied.length})</s-text>
              </s-paragraph>
              <s-unordered-list>
                {summary.applied.map((r) => (
                  <s-list-item key={r.id}>{describeFix(r)}</s-list-item>
                ))}
              </s-unordered-list>
            </>
          )}
          {summary.stale.length > 0 && (
            <>
              <s-paragraph>
                <s-text type="strong">Stale, left unchanged ({summary.stale.length})</s-text>
                : the value was edited in Shopify after the scan. Re-scan to refresh.
              </s-paragraph>
              <s-unordered-list>
                {summary.stale.map((r) => (
                  <s-list-item key={r.id}>{describeFix(r)}</s-list-item>
                ))}
              </s-unordered-list>
            </>
          )}
          {summary.failed.length > 0 && (
            <>
              <s-paragraph>
                <s-text type="strong">Failed ({summary.failed.length})</s-text>
              </s-paragraph>
              <s-unordered-list>
                {summary.failed.map((r) => (
                  <s-list-item key={r.id}>
                    {describeFix(r)}: {r.error}
                  </s-list-item>
                ))}
              </s-unordered-list>
            </>
          )}
        </s-banner>
      )}

      {!hasAnything && (
        <s-section heading="Nothing to review">
          <s-paragraph>
            There are no fix proposals and nothing needs a human look. Run a scan from Home:
            proposals appear when a metafield has a clear majority format and a few values
            that don&apos;t match it.
          </s-paragraph>
        </s-section>
      )}

      {openCount > 0 && (
        <s-section heading={`Proposed fixes (${openCount})`}>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>{approvedCount} approved</s-text>
            <s-button
              onClick={() => decide("approve", pending.map((p) => p.id))}
              disabled={pending.length === 0 || isDeciding}
            >
              Approve all ({pending.length})
            </s-button>
          </s-stack>
          {openCount > proposals.length && (
            <s-paragraph>
              <s-text color="subdued">
                Showing the first {proposals.length} of {openCount}. Approve all applies to the
                rows shown.
              </s-text>
            </s-paragraph>
          )}

          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Metafield</s-table-header>
              <s-table-header>Current value</s-table-header>
              <s-table-header>Proposed value</s-table-header>
              <s-table-header>Rule</s-table-header>
              <s-table-header>Decision</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {proposals.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-link href={adminProductUrl(shop, p.productId)} target="_top">
                      {p.productTitle}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {p.namespace}.{p.key}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>&quot;{formatMetafieldValue(p.valueType, p.originalValue)}&quot;</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text type="strong">
                      &quot;{formatMetafieldValue(p.valueType, p.proposedValue)}&quot;
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="base">
                      <s-badge>{RULE_LABEL[p.ruleType]}</s-badge>
                      <s-text color="subdued">{p.ruleDetail}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {p.status === "APPROVED" ? (
                        <s-badge tone="success">Approved</s-badge>
                      ) : (
                        <s-button
                          variant="primary"
                          accessibilityLabel={`Approve ${p.productTitle} ${p.namespace}.${p.key}`}
                          onClick={() => decide("approve", [p.id])}
                          disabled={isDeciding}
                        >
                          Approve
                        </s-button>
                      )}
                      <s-button
                        tone="critical"
                        accessibilityLabel={`Reject ${p.productTitle} ${p.namespace}.${p.key}`}
                        onClick={() => decide("reject", [p.id])}
                        disabled={isDeciding}
                      >
                        Reject
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      {flaggedCount > 0 && (
        <s-section heading={`Needs a human look (${flaggedCount})`}>
          <s-paragraph>
            These values don&apos;t match the usual format, but a safe automatic fix isn&apos;t
            possible, so there&apos;s nothing to approve. Edit them in Shopify and re-scan.
          </s-paragraph>
          {flaggedCount > flagged.length && (
            <s-paragraph>
              <s-text color="subdued">
                Showing the first {flagged.length} of {flaggedCount}.
              </s-text>
            </s-paragraph>
          )}
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Metafield</s-table-header>
              <s-table-header>Current value</s-table-header>
              <s-table-header>Why it needs a look</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {flagged.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-link href={adminProductUrl(shop, row.productId)} target="_top">
                      {row.productTitle}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {row.namespace}.{row.key}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>&quot;{formatMetafieldValue(row.expectedType, row.actualValue)}&quot;</s-text>
                  </s-table-cell>
                  <s-table-cell>{row.flagReason}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
