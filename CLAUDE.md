@AGENTS.md

# Catalog Guardian

## Project purpose

Catalog Guardian scans a merchant's products against their metafield
definitions and flags missing, empty, or inconsistent metafield values. For
inconsistent values it can fix with certainty (unit spelling, casing, naming
variants) it proposes a fix; the merchant approves or rejects each one, and
approved fixes are applied with a stale check. Values it can't fix safely are
listed under "Needs a human look". The Issues page also lets the merchant
bulk-set one value on rows for a single metafield.

## Tech stack

- Shopify CLI app template (React Router)
- Prisma with SQLite for local dev
- Polaris web components (`<s-page>`, `<s-button>`, `<s-table>`, etc.) for
  all UI — this template does not include the classic `@shopify/polaris`
  React package, so don't add it or import from it
- App Bridge for embedding in the Shopify Admin
- Shopify Admin GraphQL API for data access
- Scope: `write_products` only (it covers reading products and metafield
  definitions). Don't add scopes the code doesn't use.
- Webhooks: only `app/uninstalled` and `app/scopes_update` exist. Incremental
  updates from product webhooks are not implemented; scans are started by hand.

## Project layout

- `app/routes/`: `_index` (landing and login), `app._index` (dashboard, runs
  scans), `app.issues` (issues list and bulk fix), `app.review` (review
  queue), `app.scan-status.$scanRunId` (scan progress poll), `auth.*`,
  `webhooks.*`.
- `app/services/`: `scanEngine.server.js` (scan and classify),
  `fixProposals.server.js` (normalizer and `generateProposals`),
  `bulkFixEngine.server.js` (writes to Shopify, stale checks),
  `shopifyGraphql.server.js` (throttle-aware requests).
- `app/graphql/`: one file per operation.
- `app/utils/`: display helpers (`formatMetafieldValue`, type labels).
- `scripts/`: tests and dev-store tools (see Testing approach).

## Conventions

- Always use Polaris web components for admin UI. Never use raw HTML form
  elements (`<input>`, `<button>`, `<select>`, etc.) — use the
  corresponding `<s-*>` element instead.
- All Admin API calls go through the authenticated `admin` object from
  `shopify.server.js`. Never hardcode API tokens. Scripts get theirs from
  `unauthenticated.admin(shop)`, using the stored offline session.
- Keep GraphQL queries in a dedicated `/app/graphql` folder, one file
  per operation.
- A fix is only proposed when it is deterministic. If it can't be derived
  with certainty, flag the value instead. Don't convert between units.
  Normalizer changes need fixtures in `scripts/test-normalize.js`.
- Writes that come from proposals go through `applyApprovedProposals`, which
  re-reads the value and uses `compareDigest`. Don't write a proposal's value
  to Shopify any other way.
- Tools that write to a store (`seed`, `demo:reset`) are for development
  stores only.

## Data model note

Data lives in SQLite via Prisma (`prisma/schema.prisma`) so the dashboard
doesn't have to re-query Shopify on every page load:

- `ScanRun`: one row per scan. A run that fails saves its reason in
  `errorMessage`, and so does a complete run whose proposal generation
  failed. A RUNNING run older than 5 minutes is treated as FAILED, so a
  server restart can't block new scans.
- `ScanResult`: one row per product and metafield definition, upserted on
  every scan. `status` is OK, MISSING, EMPTY or TYPE_MISMATCH. `flagReason`
  is set when a normalizer rule saw an outlier it couldn't safely fix.
- `FixProposal`: a suggested UNIT, CASING or NAMING fix for an OK value,
  generated after each complete scan. A scan replaces only PENDING rows;
  APPROVED, REJECTED, APPLIED, FAILED and STALE rows are never touched, and a
  rejected proposal isn't recreated unless the value changes.
  `originalValue` is the scanned value. Applying re-reads the value from
  Shopify and writes with `compareDigest`, so a value changed since the scan
  ends STALE and is never overwritten. Rows have no foreign keys, so
  deleting scan data can't remove decided proposals.

After any `prisma generate` (including the one `prisma migrate dev` runs),
restart `shopify app dev`: the running server keeps the old client.

## Testing approach

There is no test framework. Checks are plain Node scripts that exit
non-zero on failure:

- `npm run test:classify`: scan status classification (`classifyMetafield`).
- `npm run test:normalize`: the normalizer rules (`proposeForField`). Every
  value in each fixture is checked, so a spurious proposal fails too.
- `npm run test:format`: display text for weight, dimension and volume
  values, and the one-line description of an applied fix (`describeFix`).
- `npm run test:stale -- <shop>.myshopify.com`: interactive, against a dev
  store. You edit a metafield in the admin while it waits; it confirms the
  apply path ends STALE and overwrites nothing.

Run the first three, `npm run lint` and `npm run build` after every change.
After every feature, also list manual checks to run against a dev store
using `shopify app dev`.

Dev-store tools (they write to a store, so they are not tests):

- `npm run scan -- <shop>.myshopify.com`: runs a scan outside the app.
- `npm run seed -- <shop>.myshopify.com`: creates a deliberately messy demo
  catalog (20 DRAFT products tagged `catalog-guardian-seed`, fields in the
  `cg_demo` namespace) so every normalizer rule has a case: 11 proposals and
  6 flagged rows. Idempotent, and `--cleanup` removes the seed products.
  `--dry-run` checks the design against the normalizer without touching
  Shopify, and fails if a rule change breaks the demo.
- `npm run demo:reset -- <shop>.myshopify.com`: puts the demo back to its
  starting state: re-runs the seed, deletes every FixProposal row for the
  shop (decided ones too), then scans to regenerate proposals. Refuses any
  store Shopify doesn't report as a development store. `--dry-run` checks
  that and changes nothing.

## Not implemented yet

List-type and product-title normalization, unit conversion, undo, billing,
incremental scanning from webhooks, and a job queue (scans run in the web
process).
