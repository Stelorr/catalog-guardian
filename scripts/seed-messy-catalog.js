// Seeds a deliberately messy demo catalog so every normalizer rule has a case.
//
//   npm run seed -- <shop>.myshopify.com             create or reset the seed catalog
//   npm run seed -- <shop>.myshopify.com --cleanup   delete the seed products
//   npm run seed -- --dry-run                        check the design, print what it should produce
//
// Safe to run repeatedly: the 20 products have fixed handles (cg-seed-01 ...)
// and are looked up by handle, so a re-run updates them instead of adding
// more. They are DRAFT products tagged "catalog-guardian-seed", and the
// fields live in their own "cg_demo" namespace, so real products can only
// ever be MISSING on them and can't change any field's majority.
//
// Reset caveat: productSet replaces a product's whole metafield and tag
// lists, so a re-run removes anything you added by hand to a seed product.
// Existing products are only touched if they carry the seed handle AND tag.
//
// --cleanup deletes the seed products only. The cg_demo metafield
// definitions stay (delete them in Settings > Custom data), and the local
// scan data keeps rows for the deleted products until the next scan.
// ponytail: seed products are found by their 20 fixed handles, not by tag
// search, because search results lag right after a create. If the seed list
// ever shrinks, delete the extra products by tag in the admin.
const args = process.argv.slice(2);
const cleanup = args.includes("--cleanup");
const dryRun = args.includes("--dry-run");
const shop = args.find((arg) => !arg.startsWith("--")) ?? process.env.SHOP;

if (!shop && !dryRun) {
  console.error("Usage: npm run seed -- <shop>.myshopify.com [--cleanup | --dry-run]");
  process.exit(1);
}

// Same reason as scripts/run-scan.js: shopify.server.js needs a URL-shaped
// SHOPIFY_APP_URL to load, and unauthenticated.admin() never uses it.
process.env.SHOPIFY_APP_URL ??= "http://localhost:3000";

const SEED_TAG = "catalog-guardian-seed";
const HANDLE_PREFIX = "cg-seed-";
const NAMESPACE = "cg_demo";
const PRODUCT_COUNT = 20;

const weight = (value, unit) => JSON.stringify({ value, unit });
const slots = (list) => [...list, ...Array(PRODUCT_COUNT - list.length).fill(null)];

const TITLES = [
  "Canvas Tote", "Linen Shirt", "Wool Beanie", "Denim Jacket", "Leather Belt",
  "Cotton Hoodie", "Merino Sweater", "Rain Shell", "Trail Backpack", "Silk Scarf",
  "Hemp Shorts", "Bamboo Socks", "Chino Pants", "Fleece Vest", "Waxed Cap",
  "Utility Apron", "Camp Blanket", "Cork Wallet", "Ripstop Duffel", "Felt Slippers",
];
const HANDLES = TITLES.map((_, i) => `${HANDLE_PREFIX}${String(i + 1).padStart(2, "0")}`);

// values: one slot per product, null = the product has no value (MISSING).
// expect: what the normalizer must do with a value. ["UNIT", "10 in"] is a
// proposal, ["FLAG"] is "needs a human look", and a value that isn't listed
// must produce nothing. checkDesign() enforces this before anything is sent
// to Shopify, so a changed threshold or rule can't silently break the demo.
const FIELDS = [
  {
    key: "width", name: "Seed width", type: "single_line_text_field",
    description: "Demo: width in inches, mostly written as 10 in",
    values: [
      "5 in", "10in", "6 in", "7 in", "12 inches", "8 in", "9 in", '8"', "10 in", "11 in",
      "25 cm", "12 in", "14 in", "10 IN", "15 in", "16 in", "10 x 12 in", "18 in",
      "approx. 10 in", "20 in",
    ],
    expect: {
      "10in": ["UNIT", "10 in"], "12 inches": ["UNIT", "12 in"], '8"': ["UNIT", "8 in"],
      "10 IN": ["UNIT", "10 in"],
      "25 cm": ["FLAG"], "10 x 12 in": ["FLAG"], "approx. 10 in": ["FLAG"],
    },
  },
  {
    key: "material", name: "Seed material", type: "single_line_text_field",
    description: "Demo: spelling variants of Organic Cotton",
    values: slots([
      "Organic Cotton", "Linen", "organic-cotton", "Organic Cotton", "Wool Blend",
      "Organic_Cotton", "Recycled Polyester", "Organic Cotton", "organic cotton", "Hemp",
      "Organic  Cotton", "Bamboo Viscose", "Cotton, Organic", "Merino Wool",
    ]),
    expect: {
      "organic cotton": ["CASING", "Organic Cotton"],
      "organic-cotton": ["NAMING", "Organic Cotton"],
      "Organic_Cotton": ["NAMING", "Organic Cotton"],
      "Organic  Cotton": ["NAMING", "Organic Cotton"],
      // "Cotton, Organic" is left alone: reordered words aren't guessed.
    },
  },
  {
    key: "color", name: "Seed color", type: "single_line_text_field",
    description: "Demo: Title Case colors with a few lowercase outliers",
    values: slots([
      "Black", "navy blue", "White", "Gray", "Forest Green", "sage green", "Sky Blue",
      "USB-C black", "Burgundy", "Charcoal", "Ivory", "Grey", "Sand", "Navy",
    ]),
    expect: {
      "navy blue": ["CASING", "Navy Blue"], "sage green": ["CASING", "Sage Green"],
      "USB-C black": ["FLAG"],
      // "Grey" is left alone: synonyms of "Gray" are never guessed.
    },
  },
  {
    key: "fit", name: "Seed fit", type: "single_line_text_field",
    description: "Demo: lowercase fit names with one Title Case outlier",
    values: slots([
      "slim fit", "regular fit", "Classic Fit", "relaxed fit", "oversized", "Athletic fit",
      "tapered", "cropped", "boxy fit",
    ]),
    expect: {
      "Classic Fit": ["CASING", "classic fit"],
      // "Athletic fit" is left alone: sentence case is written that way on purpose.
    },
  },
  {
    key: "finish", name: "Seed finish", type: "single_line_text_field",
    description: "Demo: Title Case finishes plus sentence-case values with small words",
    values: slots([
      "Matte Black", "Dark navy with gold trim", "Brushed Steel", "Polished Brass",
      "Hand-finished oak", "Natural Oak", "Raw Concrete", "Satin Nickel",
      "Wood core with fiberglass laminate",
    ]),
    expect: {}, // "with" must never become "With"
  },
  {
    key: "length", name: "Seed length", type: "single_line_text_field",
    description: "Demo: half inches, half centimeters, so no majority",
    values: slots([
      "4 in", "5 cm", "6 in", "10 cm", "8 in", "20 cm", "10 in", "25 cm", "12 in", "30 cm",
      "14 in", "35 cm",
    ]),
    expect: {},
  },
  {
    key: "weight", name: "Seed weight", type: "weight",
    description: "Demo: weights, mostly kilograms (units are never converted)",
    values: slots([
      weight(1.5, "KILOGRAMS"), weight(2, "KILOGRAMS"), weight(2.5, "KILOGRAMS"),
      weight(1500, "GRAMS"), weight(3, "KILOGRAMS"), weight(3.5, "KILOGRAMS"),
      weight(2, "POUNDS"), weight(4, "KILOGRAMS"), weight(4.5, "KILOGRAMS"),
      weight(5, "KILOGRAMS"),
    ]),
    expect: { [weight(1500, "GRAMS")]: ["FLAG"], [weight(2, "POUNDS")]: ["FLAG"] },
  },
  {
    key: "care", name: "Seed care", type: "multi_line_text_field",
    description: "Demo: free-text care notes, never normalized",
    values: slots([
      "Machine wash cold. Tumble dry low.", "machine wash cold", "Hand wash only",
      "Dry clean only", "Wash inside out with like colors.", "Do not bleach", "Air dry flat",
      "Machine Wash Cold", "Wipe clean with a damp cloth.", "Cool iron if needed",
      "Spot clean only", "Do not tumble dry", "Wash separately before first use",
      "Hang to dry", "Gentle cycle", "Store in a cool, dry place",
    ]),
    expect: {},
  },
];

const noLog = () => {};
const filled = (field) => field.values.filter((v) => v !== null);

// Runs the real normalizer on the seed values and compares the outcome with
// each field's expect map. Returns a list of problems; empty means the design
// still triggers every rule it's meant to.
function checkDesign(proposeForField) {
  const problems = [];
  for (const field of FIELDS) {
    const values = field.values
      .map((value, i) => ({ productId: HANDLES[i], productTitle: TITLES[i], value }))
      .filter((v) => v.value !== null);
    const { proposals, flags } = proposeForField({
      namespace: NAMESPACE, key: field.key, type: field.type, values,
    });

    const actual = new Map();
    for (const p of proposals) actual.set(p.originalValue, [p.ruleType, p.proposedValue]);
    const valueOf = new Map(values.map((v) => [v.productId, v.value]));
    for (const f of flags) actual.set(valueOf.get(f.productId), ["FLAG"]);

    for (const [value, want] of Object.entries(field.expect)) {
      const got = actual.get(value);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        problems.push(`${field.key}: ${JSON.stringify(value)} expected ${JSON.stringify(want)}, got ${JSON.stringify(got ?? "nothing")}`);
      }
    }
    for (const [value, got] of actual) {
      if (!(value in field.expect)) {
        problems.push(`${field.key}: ${JSON.stringify(value)} was not expected to produce ${JSON.stringify(got)}`);
      }
    }
  }
  return problems;
}

function printExpectations() {
  let proposals = 0;
  let flags = 0;
  const lines = [];
  for (const field of FIELDS) {
    for (const [value, outcome] of Object.entries(field.expect)) {
      const title = TITLES[field.values.indexOf(value)];
      if (outcome[0] === "FLAG") {
        flags++;
        lines.push(`  flagged   ${`${NAMESPACE}.${field.key}`.padEnd(18)} ${title.padEnd(16)} ${JSON.stringify(value)}`);
      } else {
        proposals++;
        lines.push(`  ${outcome[0].padEnd(9)} ${`${NAMESPACE}.${field.key}`.padEnd(18)} ${title.padEnd(16)} ${JSON.stringify(value)} -> ${JSON.stringify(outcome[1])}`);
      }
    }
  }
  const okRows = FIELDS.reduce((sum, f) => sum + filled(f).length, 0);
  const missingRows = FIELDS.length * PRODUCT_COUNT - okRows;

  console.log(`\nAfter a scan you should see (${proposals} proposals, ${flags} flagged):\n`);
  console.log(lines.join("\n"));
  console.log(`
Everything else in the seed fields should produce nothing: sentence case and
"with" in cg_demo.finish, the 50/50 cg_demo.length, "Grey" and "Cotton, Organic",
"Athletic fit", and the free-text cg_demo.care.

Scan totals for the seed fields (on top of whatever the store already had):
  seed products scanned:      ${PRODUCT_COUNT}
  OK rows:                    ${okRows}
  MISSING rows:               ${missingRows}  (products without a value)
Real products also show MISSING for the ${FIELDS.length} new definitions, and the seed products
show MISSING for the store's existing definitions.

Then: scan, open Review (${proposals} proposals, ${flags} in "Needs a human look"), approve,
Apply, and scan again. The width/material/color/fit proposals disappear and the
${flags} flagged rows stay, because there's nothing safe to apply to them.`);
}

const isSeedProduct = (product) => product.tags.includes(SEED_TAG);

async function main() {
  const { proposeForField } = await import("../app/services/fixProposals.server.js");
  const problems = checkDesign(proposeForField);
  if (problems.length > 0) {
    console.error("The seed design no longer triggers the normalizer rules it was built for:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Nothing was sent to Shopify. Update FIELDS in scripts/seed-messy-catalog.js.");
    process.exitCode = 1;
    return;
  }
  console.log(`Design check passed: ${FIELDS.length} fields, ${PRODUCT_COUNT} products.`);

  if (dryRun) {
    printExpectations();
    return;
  }

  const { unauthenticated } = await import("../app/shopify.server.js");
  const { graphqlRequest, pauseForCapacity } = await import("../app/services/shopifyGraphql.server.js");
  const { CREATE_METAFIELD_DEFINITION } = await import("../app/graphql/createMetafieldDefinition.js");
  const { GET_SEED_PRODUCT } = await import("../app/graphql/getSeedProduct.js");
  const { SET_PRODUCT } = await import("../app/graphql/setProduct.js");
  const { DELETE_PRODUCT } = await import("../app/graphql/deleteProduct.js");

  const { admin } = await unauthenticated.admin(shop);

  async function request(query, variables) {
    const { data, cost } = await graphqlRequest(admin, query, variables, noLog);
    await pauseForCapacity(cost, noLog);
    return data;
  }

  const fetchSeedProduct = async (handle) =>
    (await request(GET_SEED_PRODUCT, { handle, namespace: NAMESPACE })).productByIdentifier;

  const failIfErrors = (userErrors, what) => {
    if (userErrors.length > 0) {
      throw new Error(`${what}: ${userErrors.map((e) => `${e.message} (${e.code ?? e.field})`).join("; ")}`);
    }
  };

  if (cleanup) {
    let deleted = 0;
    let absent = 0;
    for (const handle of HANDLES) {
      const product = await fetchSeedProduct(handle);
      if (!product) {
        absent++;
      } else if (!isSeedProduct(product)) {
        console.warn(`  skipped ${handle}: it exists but isn't tagged "${SEED_TAG}", so it isn't ours`);
      } else {
        const data = await request(DELETE_PRODUCT, { input: { id: product.id } });
        failIfErrors(data.productDelete.userErrors, `Deleting ${handle}`);
        deleted++;
      }
    }
    console.log(`\nCleanup on ${shop}: deleted ${deleted} seed product(s), ${absent} were already gone.`);
    console.log("The cg_demo metafield definitions remain, and the local scan data keeps rows for the deleted products until you re-scan.");
    return;
  }

  // 1. Look up all 20 handles first, so a collision with a real product
  // stops the run before anything is written.
  const existingProducts = [];
  for (const handle of HANDLES) {
    const existing = await fetchSeedProduct(handle);
    if (existing && !isSeedProduct(existing)) {
      throw new Error(`A product with handle ${handle} exists but isn't tagged "${SEED_TAG}". Refusing to overwrite it.`);
    }
    existingProducts.push(existing);
  }

  // 2. Definitions. TAKEN means it already exists, which is fine.
  let definitionsCreated = 0;
  for (const field of FIELDS) {
    const data = await request(CREATE_METAFIELD_DEFINITION, {
      definition: {
        name: field.name, namespace: NAMESPACE, key: field.key, type: field.type,
        description: field.description, ownerType: "PRODUCT",
      },
    });
    const errors = data.metafieldDefinitionCreate.userErrors;
    if (errors.length === 0) definitionsCreated++;
    else failIfErrors(errors.filter((e) => e.code !== "TAKEN"), `Creating ${NAMESPACE}.${field.key}`);
  }

  // 3. Products: update by id if the handle exists, otherwise create.
  let created = 0;
  let updated = 0;
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const existing = existingProducts[i];
    const data = await request(SET_PRODUCT, {
      identifier: existing ? { id: existing.id } : undefined,
      input: {
        title: TITLES[i],
        handle: HANDLES[i],
        status: "DRAFT",
        tags: [SEED_TAG],
        metafields: FIELDS.filter((f) => f.values[i] !== null).map((f) => ({
          namespace: NAMESPACE, key: f.key, type: f.type, value: f.values[i],
        })),
      },
    });
    failIfErrors(data.productSet.userErrors, `Saving ${HANDLES[i]}`);
    if (existing) updated++;
    else created++;
  }

  // 4. Read everything back: Shopify may normalize a value (trim, collapse
  // spaces), which would quietly remove a demo case.
  const same = (type, a, b) => (type === "weight" ? a != null && b != null && JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) : a === b);
  const differences = [];
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const product = await fetchSeedProduct(HANDLES[i]);
    const stored = new Map((product?.metafields.nodes ?? []).map((m) => [m.key, m.value]));
    for (const field of FIELDS) {
      const want = field.values[i];
      const got = stored.get(field.key) ?? null;
      if (!same(field.type, want, got) && !(want === null && got === null)) {
        differences.push(`${HANDLES[i]} ${field.key}: sent ${JSON.stringify(want)}, Shopify has ${JSON.stringify(got)}`);
      }
    }
  }

  console.log(`\nSeeded ${shop}:`);
  console.log(`  metafield definitions: ${definitionsCreated} created, ${FIELDS.length - definitionsCreated} already existed`);
  console.log(`  products:              ${created} created, ${updated} updated (DRAFT, tagged "${SEED_TAG}")`);
  if (differences.length > 0) {
    console.log(`\nWARNING: ${differences.length} value(s) came back different, so some demo cases may not trigger:`);
    for (const d of differences) console.log(`  - ${d}`);
    process.exitCode = 1;
  } else {
    console.log("  read-back:             every value matches what was sent");
  }
  printExpectations();
  console.log(`\nNext: npm run scan -- ${shop}`);
}

const { default: prisma } = await import("../app/db.server.js");
try {
  await main();
} catch (error) {
  console.error(`\nSeed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
