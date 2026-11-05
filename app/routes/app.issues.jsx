import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bulkFixMetafield } from "../services/bulkFixEngine.server";
import {
  getMetafieldInputKind,
  getMetafieldTypeLabel,
} from "../utils/metafieldTypeLabels";

// Rows this long would blow out the table's row height; the full value is
// still available via the native title tooltip on hover.
const VALUE_PREVIEW_LENGTH = 80;

function previewValue(value) {
  if (value.length <= VALUE_PREVIEW_LENGTH) return value;
  return `${value.slice(0, VALUE_PREVIEW_LENGTH)}…`;
}

const PAGE_SIZE = 50;
const ISSUE_STATUSES = ["MISSING", "EMPTY", "TYPE_MISMATCH"];
const STATUS_LABEL = {
  MISSING: "Missing",
  EMPTY: "Empty",
  TYPE_MISMATCH: "Type mismatch",
};
// s-badge has no "attention" tone (the closest classic-Polaris equivalent
// here); "caution" is the nearest match in the current tone vocabulary.
const STATUS_TONE = {
  MISSING: "critical",
  EMPTY: "warning",
  TYPE_MISMATCH: "caution",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);

  const statusParam = url.searchParams.get("status");
  const status = ISSUE_STATUSES.includes(statusParam) ? statusParam : null;
  const metafieldKeyParam = url.searchParams.get("metafieldKey") || "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where = {
    shop,
    status: status ?? { in: ISSUE_STATUSES },
  };
  if (metafieldKeyParam.includes(".")) {
    const [namespace, key] = metafieldKeyParam.split(".");
    where.namespace = namespace;
    where.key = key;
  }

  const [rows, totalCount, metafieldGroups] = await Promise.all([
    prisma.scanResult.findMany({
      where,
      orderBy: [{ lastCheckedAt: "desc" }, { productTitle: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.scanResult.count({ where }),
    // Options for the metafield filter reflect the full set of current
    // issues, not narrowed by the active filters, so switching one filter
    // never removes options the other filter could otherwise combine with.
    prisma.scanResult.groupBy({
      by: ["namespace", "key"],
      where: { shop, status: { in: ISSUE_STATUSES } },
      orderBy: [{ namespace: "asc" }, { key: "asc" }],
    }),
  ]);

  return {
    rows,
    page,
    pageSize: PAGE_SIZE,
    totalCount,
    metafieldOptions: metafieldGroups.map((g) => `${g.namespace}.${g.key}`),
    filters: { status: status ?? "", metafieldKey: metafieldKeyParam },
    shop,
  };
};

function adminProductUrl(shop, productGid) {
  const numericId = productGid.split("/").pop();
  return `https://${shop}/admin/products/${numericId}`;
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const scanResultIds = formData.getAll("scanResultId");
  const value = formData.get("value") ?? "";

  try {
    const results = await bulkFixMetafield({
      admin,
      shop: session.shop,
      scanResultIds,
      value,
    });
    return { results };
  } catch (error) {
    // Reachable if a request bypasses the UI's own same-metafield guard;
    // the button is disabled client-side whenever the selection is mixed.
    return { error: error.message };
  }
};

export default function Issues() {
  const { rows, page, pageSize, totalCount, metafieldOptions, filters, shop } =
    useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const tableRef = useRef(null);
  const modalRef = useRef(null);
  const bannerRef = useRef(null);
  const shopify = useAppBridge();
  const bulkFixFetcher = useFetcher();
  const [fixValue, setFixValue] = useState("");
  const [bannerFailures, setBannerFailures] = useState(null);

  // Selection is scoped to what's currently visible — changing a filter or
  // page invalidates the previous selection rather than carrying over ids
  // that may no longer be on screen.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [rows]);

  const hasNextPage = page * pageSize < totalCount;
  const hasPreviousPage = page > 1;

  const goToPage = (nextPage) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(nextPage));
    setSearchParams(next);
  };

  // <s-table> fires non-standard "nextpage"/"previouspage" events. React 18
  // only auto-wires onX props for its built-in known DOM events (click,
  // change, ...), not arbitrary custom element events, so these need a
  // manual listener rather than onNextPage/onPreviousPage JSX props.
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return undefined;

    const handleNext = () => goToPage(page + 1);
    const handlePrevious = () => goToPage(page - 1);
    el.addEventListener("nextpage", handleNext);
    el.addEventListener("previouspage", handlePrevious);

    return () => {
      el.removeEventListener("nextpage", handleNext);
      el.removeEventListener("previouspage", handlePrevious);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const updateFilter = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    next.delete("page");
    setSearchParams(next);
  };

  const selectedRows = rows.filter((r) => selectedIds.has(r.id));
  const selectionKeys = new Set(selectedRows.map((r) => `${r.namespace}.${r.key}`));
  // All rows sharing one namespace.key share the same expectedType and
  // description too, since those come from the shop-wide definition, not
  // the individual product — so any one representative row carries
  // everything the modal needs.
  const bulkFixGroup = selectionKeys.size === 1 ? selectedRows[0] : null;
  const canBulkFix = selectedRows.length > 0 && bulkFixGroup !== null;
  const inputKind = bulkFixGroup ? getMetafieldInputKind(bulkFixGroup.expectedType) : "generic";

  // Reset the modal's form state fresh every time it's opened, and whenever
  // the selected group's input kind changes so a stale default (e.g. "false"
  // left over from a previous boolean fix) doesn't leak into a new one. This
  // is a genuinely custom <s-modal> event ("show"), not a standard DOM
  // event, so it needs a manual listener rather than an onShow JSX prop —
  // same React 18 limitation as the table's pagination events.
  useEffect(() => {
    const el = modalRef.current;
    if (!el) return undefined;
    const handleShow = () => setFixValue(inputKind === "boolean" ? "false" : "");
    el.addEventListener("show", handleShow);
    return () => el.removeEventListener("show", handleShow);
  }, [inputKind]);

  useEffect(() => {
    if (!bulkFixFetcher.data) return;

    if (bulkFixFetcher.data.error) {
      shopify.toast.show(bulkFixFetcher.data.error);
      return;
    }

    const { results } = bulkFixFetcher.data;
    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    shopify.toast.show(
      failed.length === 0
        ? `Updated ${succeeded.length} product${succeeded.length === 1 ? "" : "s"}`
        : `Updated ${succeeded.length} of ${results.length} products`,
    );
    setBannerFailures(failed.length > 0 ? failed : null);
    modalRef.current?.hideOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkFixFetcher.data]);

  // <s-banner>'s dismiss button fires a custom "dismiss" event rather than
  // hiding itself — the consumer owns removing it. Re-bound whenever the
  // banner mounts/unmounts since it's only rendered while there's a failure.
  useEffect(() => {
    const el = bannerRef.current;
    if (!el) return undefined;
    const handleDismiss = () => setBannerFailures(null);
    el.addEventListener("dismiss", handleDismiss);
    return () => el.removeEventListener("dismiss", handleDismiss);
  }, [bannerFailures]);

  const handleSubmitFix = () => {
    const formData = new FormData();
    for (const row of selectedRows) {
      formData.append("scanResultId", row.id);
    }
    formData.append("value", fixValue);
    bulkFixFetcher.submit(formData, { method: "POST" });
  };

  const toggleAll = (checked) => {
    setSelectedIds(checked ? new Set(rows.map((r) => r.id)) : new Set());
  };

  const toggleOne = (id, checked) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const someSelected = rows.some((r) => selectedIds.has(r.id));

  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalCount);

  return (
    <s-page heading="Issues">
      <s-section heading="Filters">
        <s-stack direction="inline" gap="base">
          <s-select
            label="Status"
            value={filters.status || "ALL"}
            onChange={(e) =>
              updateFilter(
                "status",
                e.currentTarget.value === "ALL" ? null : e.currentTarget.value,
              )
            }
          >
            <s-option value="ALL">All statuses</s-option>
            {ISSUE_STATUSES.map((status) => (
              <s-option key={status} value={status}>
                {STATUS_LABEL[status]}
              </s-option>
            ))}
          </s-select>

          <s-select
            label="Metafield"
            value={filters.metafieldKey || "ALL"}
            onChange={(e) =>
              updateFilter(
                "metafieldKey",
                e.currentTarget.value === "ALL" ? null : e.currentTarget.value,
              )
            }
          >
            <s-option value="ALL">All metafields</s-option>
            {metafieldOptions.map((option) => (
              <s-option key={option} value={option}>
                {option}
              </s-option>
            ))}
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading={`Issues (${totalCount})`}>
        {bannerFailures && (
          <s-banner
            ref={bannerRef}
            tone="warning"
            heading={`${bannerFailures.length} product${bannerFailures.length === 1 ? "" : "s"} couldn't be updated`}
            dismissible
          >
            <s-unordered-list>
              {bannerFailures.map((failure) => (
                <s-list-item key={failure.id}>
                  {failure.productTitle}: {failure.error}
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}

        {selectedIds.size > 0 && (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>{selectedRows.length} selected</s-text>
            <s-button commandFor="bulk-fix-modal" command="--show" disabled={!canBulkFix}>
              Bulk Fix
            </s-button>
            {!canBulkFix && (
              <s-text tone="critical">
                Select rows for a single metafield to bulk-fix — you have{" "}
                {selectionKeys.size} different metafields selected. Try the
                Metafield filter above to narrow your selection.
              </s-text>
            )}
          </s-stack>
        )}

        {rows.length === 0 ? (
          <s-paragraph>No issues match the current filters.</s-paragraph>
        ) : (
          <>
            <s-table
              ref={tableRef}
              paginate
              hasPreviousPage={hasPreviousPage}
              hasNextPage={hasNextPage}
            >
              <s-table-header-row>
                <s-table-header>
                  <s-checkbox
                    accessibilityLabel="Select all issues on this page"
                    checked={allSelected}
                    indeterminate={!allSelected && someSelected}
                    onChange={(e) => toggleAll(e.currentTarget.checked)}
                  />
                </s-table-header>
                <s-table-header>Product</s-table-header>
                <s-table-header>Metafield</s-table-header>
                <s-table-header>Expected type</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Current value</s-table-header>
                <s-table-header>Last checked</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      <s-checkbox
                        accessibilityLabel={`Select ${row.productTitle} — ${row.namespace}.${row.key}`}
                        checked={selectedIds.has(row.id)}
                        onChange={(e) => toggleOne(row.id, e.currentTarget.checked)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={adminProductUrl(shop, row.productId)} target="_top">
                        {row.productTitle}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="base">
                        <s-text>
                          {row.namespace}.{row.key}
                        </s-text>
                        {row.description && (
                          <s-text color="subdued">{row.description}</s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{getMetafieldTypeLabel(row.expectedType)}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[row.status]}>
                        {STATUS_LABEL[row.status]}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {row.status === "EMPTY" || row.status === "TYPE_MISMATCH" ? (
                        <span title={row.actualValue}>
                          &quot;{previewValue(row.actualValue)}&quot;
                        </span>
                      ) : (
                        <s-text color="subdued">—</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(row.lastCheckedAt).toLocaleString()}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-paragraph>
              <s-text color="subdued">
                Showing {rangeStart}–{rangeEnd} of {totalCount}
              </s-text>
            </s-paragraph>
          </>
        )}
      </s-section>

      <s-modal
        ref={modalRef}
        id="bulk-fix-modal"
        heading={bulkFixGroup ? `Fix ${bulkFixGroup.namespace}.${bulkFixGroup.key}` : "Bulk fix"}
        accessibilityLabel="Bulk fix metafield"
      >
        {bulkFixGroup ? (
          <>
            <s-paragraph>{getMetafieldTypeLabel(bulkFixGroup.expectedType)}</s-paragraph>
            {bulkFixGroup.description && (
              <s-paragraph>
                <s-text color="subdued">{bulkFixGroup.description}</s-text>
              </s-paragraph>
            )}

            {inputKind === "text" && (
              <s-text-field
                label="New value"
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}
            {inputKind === "textarea" && (
              <s-text-area
                label="New value"
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}
            {inputKind === "integer" && (
              <s-number-field
                label="New value"
                step="1"
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}
            {inputKind === "decimal" && (
              <s-number-field
                label="New value"
                step="0.01"
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}
            {inputKind === "boolean" && (
              <s-switch
                label="Value is true"
                checked={fixValue === "true"}
                onChange={(e) => setFixValue(e.currentTarget.checked ? "true" : "false")}
              />
            )}
            {inputKind === "url" && (
              <s-url-field
                label="New value"
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}
            {inputKind === "date" && (
              <s-date-field
                label="New value"
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}
            {inputKind === "generic" && (
              <s-text-field
                label="New value (raw)"
                details={`Enter the raw value Shopify expects for ${getMetafieldTypeLabel(bulkFixGroup.expectedType)}.`}
                value={fixValue}
                onChange={(e) => setFixValue(e.currentTarget.value)}
              />
            )}

            <s-paragraph>
              <s-text color="subdued">
                This sets the same value on {selectedRows.length} product
                {selectedRows.length === 1 ? "" : "s"}.
              </s-text>
            </s-paragraph>
          </>
        ) : (
          <s-paragraph>Select rows for a single metafield to bulk-fix.</s-paragraph>
        )}

        <s-button slot="secondary-actions" onClick={() => modalRef.current?.hideOverlay()}>
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleSubmitFix}
          disabled={!bulkFixGroup || fixValue.trim() === "" || bulkFixFetcher.state !== "idle"}
          {...(bulkFixFetcher.state !== "idle" ? { loading: true } : {})}
        >
          Update {selectedRows.length} product{selectedRows.length === 1 ? "" : "s"}
        </s-button>
      </s-modal>
    </s-page>
  );
}
