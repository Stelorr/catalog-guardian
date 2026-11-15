@AGENTS.md

# Catalog Guardian

## Project purpose

Catalog Guardian scans a merchant's products against their metafield
definitions and flags missing, empty, or inconsistent metafield values,
then lets the merchant bulk-fix them.

## Tech stack

- Shopify CLI app template (React Router)
- Prisma with SQLite for local dev
- Polaris web components (`<s-page>`, `<s-button>`, `<s-table>`, etc.) for
  all UI — this template does not include the classic `@shopify/polaris`
  React package, so don't add it or import from it
- App Bridge for embedding in the Shopify Admin
- Shopify Admin GraphQL API for data access
- Webhooks for incremental updates

## Conventions

- Always use Polaris web components for admin UI. Never use raw HTML form
  elements (`<input>`, `<button>`, `<select>`, etc.) — use the
  corresponding `<s-*>` element instead.
- All Admin API calls go through the authenticated `admin` object from
  `shopify.server.js`. Never hardcode API tokens.
- Keep GraphQL queries in a dedicated `/app/graphql` folder, one file
  per operation.

## Data model note

Data lives in SQLite via Prisma (`prisma/schema.prisma`) so the dashboard
doesn't have to re-query Shopify on every page load:

- `ScanRun`: one row per scan. A run that fails saves its reason in
  `errorMessage`. A RUNNING run older than 5 minutes is treated as FAILED,
  so a server restart can't block new scans.
- `ScanResult`: one row per product and metafield definition, upserted on
  every scan. `status` is OK, MISSING, EMPTY or TYPE_MISMATCH. `flagReason`
  is set when a normalizer rule saw an outlier it couldn't safely fix.
- `FixProposal`: a suggested UNIT, CASING or NAMING fix for an OK value,
  generated after each complete scan. A scan replaces only PENDING rows;
  APPROVED, REJECTED, APPLIED, FAILED and STALE rows are never touched.
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
  values on the Review page (`formatMetafieldValue`).
- `npm run test:stale -- <shop>.myshopify.com`: interactive, against a dev
  store. You edit a metafield in the admin while it waits; it confirms the
  apply path ends STALE and overwrites nothing.
- `npm run seed -- <shop>.myshopify.com`: creates a deliberately messy demo
  catalog (20 DRAFT products tagged `catalog-guardian-seed`, fields in the
  `cg_demo` namespace) so every normalizer rule has a case. Idempotent, and
  `--cleanup` removes the seed products. `--dry-run` checks the design
  against the normalizer without touching Shopify.
- `npm run demo:reset -- <shop>.myshopify.com`: puts the demo back to its
  starting state: re-runs the seed, deletes every FixProposal row for the
  shop (decided ones too), then scans to regenerate proposals. Refuses any
  store Shopify doesn't report as a development store. `--dry-run` checks
  that and changes nothing.

Run the first three and `npm run lint` after every change. After every
feature, also list manual checks to run against a dev store using
`shopify app dev`.
