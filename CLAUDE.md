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

Scan results will be stored locally (see Phase 3) so the dashboard
doesn't have to re-query Shopify on every page load.

## Testing approach

There is no automated test suite yet. After every feature, list manual
checks to run against a dev store using `shopify app dev`.
