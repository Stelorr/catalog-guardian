// Throttle-aware Admin GraphQL request helper, shared by anything that
// makes its own Shopify API calls outside a single request/response cycle
// (the scan engine, the bulk-fix engine) — see the Phase 4 discussion of
// cost-based rate limiting for why this exists.
const MAX_THROTTLE_RETRIES = 5;
// Leave headroom so the next request is not rejected outright.
const CAPACITY_MARGIN = 1.25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(errors) {
  return Boolean(
    errors?.some(
      (error) =>
        error?.extensions?.code === "THROTTLED" ||
        /throttled/i.test(error?.message ?? ""),
    ),
  );
}

function capacityWaitMs(cost) {
  const throttleStatus = cost?.throttleStatus;
  if (!throttleStatus?.restoreRate) return 0;
  const needed = Math.ceil((cost.requestedQueryCost ?? 0) * CAPACITY_MARGIN);
  const deficit = needed - throttleStatus.currentlyAvailable;
  if (deficit <= 0) return 0;
  return Math.ceil((deficit / throttleStatus.restoreRate) * 1000);
}

export async function graphqlRequest(admin, query, variables, log) {
  for (let attempt = 0; ; attempt++) {
    const response = await admin.graphql(query, { variables });
    const body = await response.json();

    if (isThrottled(body.errors)) {
      if (attempt >= MAX_THROTTLE_RETRIES) {
        throw new Error(
          `Still throttled after ${MAX_THROTTLE_RETRIES} retries: ${JSON.stringify(body.errors)}`,
        );
      }
      const waitMs = capacityWaitMs(body.extensions?.cost) || 1000 * 2 ** attempt;
      log(`Throttled, waiting ${waitMs}ms before retry ${attempt + 1}`);
      await sleep(waitMs);
      continue;
    }

    if (body.errors?.length) {
      throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    }

    return { data: body.data, cost: body.extensions?.cost };
  }
}

export async function pauseForCapacity(cost, log) {
  const waitMs = capacityWaitMs(cost);
  if (waitMs > 0) {
    log(`Approaching rate limit, pausing ${waitMs}ms`);
    await sleep(waitMs);
  }
}
