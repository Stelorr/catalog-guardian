# Catalog Guardian

A Shopify app that finds inconsistent product metafield data and fixes it safely, one reviewed change at a time.

Screenshots: see /docs/screenshots

## The problem

Product data gets messy as a catalog grows. The same value is typed a dozen ways, and filters, feeds and storefront copy quietly break:

| Typed by hand | Should be |
|---|---|
| `10in`, `12 inches`, `8"`, `10 IN` | `10 in` |
| `organic-cotton`, `Organic_Cotton`, `organic cotton` | `Organic Cotton` |
| `navy blue` in a column of `Navy`, `Sky Blue`, `Forest Green` | `Navy Blue` |

Catalog Guardian scans every product against your metafield definitions, works out what each field normally looks like, and proposes fixes only for the values that don't match. It never guesses: anything it can't fix with certainty is flagged for a person instead.

## Features

- **Scan.** Checks every product against its metafield definitions and records each value as OK, missing, empty, or the wrong type. Scans run in the background, show live progress, and are throttle-aware.
- **Issues list.** A filterable, paginated table of everything wrong, with bulk fix for a single metafield.
- **Fix proposals.** After each scan, unit, casing and naming outliers get a proposed fix with the reason it was proposed.
- **Approve or reject.** Review each proposal, or approve them all, then apply.
- **Safe apply.** Each fix is written only if the value in Shopify is still the one that was scanned, using Shopify's `compareDigest`. Anything edited in the meantime is reported as stale and left alone.
- **Needs a human look.** Values that are inconsistent but can't be fixed deterministically (`25 cm` in a column of inches, `10 x 12 in`, `USB-C black`) are listed with the reason, with no approve button.

## Tech stack

- Shopify app built with the React Router app template
- Polaris web components (`<s-page>`, `<s-table>`, ...) and App Bridge for the embedded admin UI
- Prisma with SQLite for scan results and proposals
- Shopify Admin GraphQL API

## How it works

```
scan  ->  ScanResult  ->  generateProposals  ->  FixProposal  ->  Review page  ->  apply
(Admin API)  (one row per        (normalizer)     (PENDING ...)     (approve /      (re-read, then
              product+field)                                         reject)         compareDigest write)
```

- `app/services/scanEngine.server.js` pages through products and classifies each value.
- `app/services/fixProposals.server.js` holds the normalizer (`proposeForField`, a pure function) and `generateProposals`.
- `app/services/bulkFixEngine.server.js` writes values to Shopify, with the stale checks.
- Routes: `/app` (dashboard), `/app/issues`, `/app/review`.
- GraphQL lives in `app/graphql`, one file per operation.

## Design decisions

**Dominant-pattern normalizer.** A field is only normalized when it has at least 5 values and one pattern covers at least 60% of them, and only the outliers get a proposal. For spelling variants, the winning spelling needs at least 2 uses and more uses than any other spelling, so a tie proposes nothing. Casing only re-cases values written entirely in one style (all lowercase, or all Title Case where lowercase is the majority). Sentence case is assumed to be deliberate and left alone, and acronyms and brand-style words are flagged.

**Strict same-unit normalization.** `10in`, `12 inches`, `8"` and `10 IN` all become `10 in`, because that only changes spelling. A value in a different unit (`25 cm` in an inches column, or grams in a kilograms weight field) is flagged, never converted. Conversion is lossy and often ambiguous, so it is a deliberate non-feature for v1.

**Deterministic or flagged.** If a fix can't be derived with certainty from the data, it isn't proposed. The cost is a longer "needs a human look" list. A wrong automatic fix to someone's catalog is worse.

**Idempotent proposal regeneration.** A scan replaces only PENDING proposals. Approved, rejected, applied, failed and stale rows are never touched, and a rejected proposal isn't recreated unless the underlying value changes. Proposals deliberately have no foreign keys to scan data, so deleting scan runs can't erase decided proposals or the original values kept for undo.

**Optimistic concurrency.** Applying a proposal first re-reads the current value from Shopify and skips it if it changed since the scan. The write then carries the metafield's `compareDigest`, so an edit made between the read and the write is rejected by Shopify (`STALE_OBJECT` / `INVALID_COMPARE_DIGEST`) and also ends as STALE. Each product gets its own `metafieldsSet` call, because Shopify applies a batched call atomically and one bad product would block the rest.

**Failures are visible.** A failed scan saves its error message and the step it failed in on the scan run, and a scan stuck in RUNNING for more than 5 minutes (for example after a server restart) is treated as failed so it can't block new scans.

## Setup

Prerequisites:

- Node.js 20.19+ (below 22) or 22.12+
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- A Shopify Partner account and a development store

```shell
npm install
npm run setup          # generates the Prisma client and creates the SQLite database
npm run config:link    # links this checkout to your own Shopify app
npm run dev            # shopify app dev: starts the server and tunnel
```

Press `P` in the terminal to open the app, and install it on your development store. The scripts below use the credentials in `.env` and the install's saved session. If `.env` is missing, create it with `shopify app env pull`.

Load the demo data and try it:

```shell
npm run seed -- <shop>.myshopify.com         # 20 draft products with deliberately messy values
```

Then open the app, press **Run scan** on Home, and open **Review**. The seed is built so every rule has a case: expect 11 proposals and 6 rows under "Needs a human look". Approve, apply, and scan again: the proposals disappear and the flagged rows stay.

```shell
npm run demo:reset -- <shop>.myshopify.com   # back to the starting state (development stores only)
npm run seed -- <shop>.myshopify.com --cleanup   # delete the seed products
```

`seed` is idempotent: it uses fixed handles and a `catalog-guardian-seed` tag, never touches other products, and its fields live in their own `cg_demo` namespace. `demo:reset` refuses any store Shopify doesn't report as a development store.

**After any `prisma generate` (including the one `prisma migrate dev` runs), restart `shopify app dev`.** The running server keeps the old Prisma client in memory, and scans fail with `Unknown argument` errors until it is restarted.

## Tests

There is no test framework. Each check is a plain Node script that exits non-zero on failure:

```shell
npm run test:classify    # scan status classification
npm run test:normalize   # normalizer rules; every value in every fixture is checked
npm run test:format      # display text for weight/dimension values on the Review page
npm run lint
npm run test:stale -- <shop>.myshopify.com   # interactive: edit a metafield in the admin while it waits
```

`test:stale` runs against a real store and confirms that a value edited after the scan ends STALE and is never overwritten, including the case where the edit lands between the read and the write.

## Roadmap and limitations

- **Single-value metafields only.** List-type metafields and product titles aren't normalized yet.
- **No unit conversion.** Planned for v2, with explicit rounding rules.
- **No undo button yet.** The original value is stored on every proposal, so it is a small addition.
- **Billing is not implemented.**
- **No incremental scanning.** Scans are started by hand. Product webhooks aren't wired up.
- **No job queue.** A scan runs inside the web process, and applying many fixes holds one request open. The review page shows the first 200 rows of each list.
- **SQLite is for local development.** A hosted deployment needs a production database (change the Prisma provider).
- **The Issues page bulk fix** sets one typed value on the selected rows and does not run the stale check that applying proposals does.
