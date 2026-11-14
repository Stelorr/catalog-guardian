import { proposeForField } from "../app/services/fixProposals.server.js";

function field(key, type, values) {
  return {
    namespace: "custom",
    key,
    type,
    values: values.map((value, i) => ({
      productId: `gid://shopify/Product/${i + 1}`,
      productTitle: `Product ${i + 1}`,
      value,
    })),
  };
}

const dim = (value, unit) => JSON.stringify({ value, unit });
const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

// Each fixture lists the outcome for specific values: [rule, proposedValue]
// for a proposal, or ["FLAG", /reason/] for a flag. Every value not listed
// must produce neither, so a spurious proposal fails the test too.
const fixtures = [
  {
    name: "width_text: text measurements, majority \"N in\"",
    field: field("width_text", "single_line_text_field", [
      ...repeat(13, (i) => `${i + 5} in`),
      "10.50 in",
      "10in",
      "12 inches",
      '8"',
      "10 IN",
      "25 cm",
      "10 x 12 in",
      "approx. 10 in",
      "10-12 in",
    ]),
    expect: {
      "10in": ["UNIT", "10 in"],
      "12 inches": ["UNIT", "12 in"],
      '8"': ["UNIT", "8 in"],
      "10 IN": ["UNIT", "10 in"],
      "25 cm": ["FLAG", /different unit/i],
      "10 x 12 in": ["FLAG", /compound/i],
      "approx. 10 in": ["FLAG", /extra text/i],
      "10-12 in": ["FLAG", /range/i],
      // "10.50 in" is absent on purpose: the unit matches, and numbers are
      // never rewritten.
    },
  },
  {
    name: "length_text: 50/50 in and cm, no dominant format",
    field: field("length_text", "single_line_text_field", [
      ...repeat(10, (i) => `${i + 1} in`),
      ...repeat(10, (i) => `${i + 1} cm`),
    ]),
    expect: {},
  },
  {
    name: "depth (dimension): minority units are flagged, never converted",
    field: field("depth", "dimension", [
      ...repeat(17, (i) => dim(i + 5, "INCHES")),
      dim(25.4, "CENTIMETERS"),
      dim(30, "CENTIMETERS"),
    ]),
    expect: {
      [dim(25.4, "CENTIMETERS")]: ["FLAG", /CENTIMETERS.*majority INCHES/],
      [dim(30, "CENTIMETERS")]: ["FLAG", /aren't converted/],
    },
  },
  {
    name: "weight (weight): grams in a kilograms field are flagged",
    field: field("weight", "weight", [
      ...repeat(18, (i) => dim(i + 1, "KILOGRAMS")),
      dim(1500, "GRAMS"),
    ]),
    expect: { [dim(1500, "GRAMS")]: ["FLAG", /GRAMS/] },
  },
  {
    name: "material: spelling variants of \"Organic Cotton\"",
    field: field("material", "single_line_text_field", [
      ...repeat(3, () => "Organic Cotton"),
      ...repeat(3, () => "Linen"),
      ...repeat(3, () => "Wool Blend"),
      ...repeat(3, () => "Recycled Polyester"),
      "organic cotton",
      "ORGANIC COTTON",
      "organic-cotton",
      "Organic_Cotton",
      "Organic  Cotton ",
      "Cotton, Organic",
    ]),
    expect: {
      "organic cotton": ["CASING", "Organic Cotton"],
      "ORGANIC COTTON": ["CASING", "Organic Cotton"],
      "organic-cotton": ["NAMING", "Organic Cotton"],
      "Organic_Cotton": ["NAMING", "Organic Cotton"],
      "Organic  Cotton ": ["NAMING", "Organic Cotton"],
      // "Cotton, Organic" is absent: reordered words aren't guessed.
    },
  },
  {
    name: "color: majority Title Case style",
    field: field("color", "single_line_text_field", [
      ...repeat(3, () => "Gray"),
      ...repeat(3, () => "Black"),
      ...repeat(3, () => "Forest Green"),
      ...repeat(3, () => "Sky Blue"),
      ...repeat(2, () => "Red"),
      "navy blue",
      "USB-C black",
      "iPhone blue",
      "4K white",
      "Grey",
      "  Sand ",
    ]),
    expect: {
      "navy blue": ["CASING", "Navy Blue"],
      "USB-C black": ["FLAG", /"USB-C" is ALL CAPS/],
      "iPhone blue": ["FLAG", /"iPhone" is mixed case/],
      "4K white": ["FLAG", /"4K" mixes letters and digits/],
      "  Sand ": ["NAMING", "Sand"],
      // "Grey" is absent: synonyms of "Gray" are never guessed.
    },
  },
  {
    // Real values from the dev store's custom.material on 2026-11-05. The
    // first version of the style rule wrongly proposed Title Case for all 3.
    name: "real dev-store material: sentence case is left alone",
    field: field("material_real", "single_line_text_field", [
      ...repeat(5, () => "Recycled Aluminum"),
      "Wood",
      "Bamboo core",
      "Aluminum core with carbon fiber topsheet",
      "Wood core with fiberglass laminate",
    ]),
    expect: {},
  },
  {
    name: "Title Case majority: sentence-case outliers are never re-cased",
    field: field("finish", "single_line_text_field", [
      ...repeat(3, () => "Matte Black"),
      ...repeat(3, () => "Brushed Steel"),
      ...repeat(3, () => "Polished Brass"),
      "Dark navy",
      "Light gray heather",
      "Hand-finished oak",
      "Soft touch coating",
      "brushed nickel",
    ]),
    expect: {
      // Fully lowercase, so it's re-cased; the four sentence-case values
      // above it are absent on purpose.
      "brushed nickel": ["CASING", "Brushed Nickel"],
    },
  },
  {
    name: "lowercase majority: Title Case becomes lowercase, sentence case is left alone",
    field: field("tag", "single_line_text_field", [
      ...repeat(3, () => "cotton"),
      ...repeat(3, () => "linen"),
      ...repeat(2, () => "wool blend"),
      "Silk Blend",
      "Hand wash only",
    ]),
    expect: { "Silk Blend": ["CASING", "silk blend"] },
  },
  {
    name: "tie: one \"Organic Cotton\" vs one \"organic cotton\" falls back to style",
    field: field("tie", "single_line_text_field", [
      "Organic Cotton",
      "organic cotton",
      "Linen",
      "Silk",
      "Hemp",
      "Wool",
    ]),
    expect: { "organic cotton": ["CASING", "Organic Cotton"] },
  },
  {
    name: "small sample: under 5 values proposes nothing",
    field: field("small", "single_line_text_field", ["Red", "red", "RED", "navy blue"]),
    expect: {},
  },
  {
    name: "multi-line text is never normalized",
    field: field("care", "multi_line_text_field", [
      ...repeat(5, () => "Machine Wash Cold"),
      "machine wash cold",
    ]),
    expect: {},
  },
  {
    name: "list types are v2: never normalized in v1",
    field: field("sizes", "list.single_line_text_field", [
      ...repeat(5, () => '["Small","Medium"]'),
      '["small","medium"]',
    ]),
    expect: {},
  },
  {
    name: "blank values are ignored (MISSING/EMPTY never reach the rules)",
    field: field("blank", "single_line_text_field", [
      ...repeat(5, () => "Blue"),
      "",
      "   ",
    ]),
    expect: {},
  },
];

let checks = 0;
let failures = 0;

for (const fixture of fixtures) {
  const { proposals, flags } = proposeForField(fixture.field);
  const byProduct = new Map();
  for (const p of proposals) byProduct.set(p.productId, ["proposal", p]);
  for (const f of flags) {
    // A value must never be both proposed and flagged.
    byProduct.set(f.productId, byProduct.has(f.productId) ? ["both", f] : ["flag", f]);
  }

  console.log(`\n${fixture.name}`);
  for (const { productId, value } of fixture.field.values) {
    checks++;
    const expected = fixture.expect[value] ?? null;
    const [kind, out] = byProduct.get(productId) ?? ["none", null];

    let pass;
    if (expected === null) pass = kind === "none";
    else if (expected[0] === "FLAG") pass = kind === "flag" && expected[1].test(out.reason);
    else pass = kind === "proposal" && out.ruleType === expected[0] && out.proposedValue === expected[1];

    if (!pass) failures++;
    // Keep output readable: only print the interesting values and failures.
    if (expected !== null || !pass) {
      const actual =
        kind === "none" ? "nothing"
          : kind === "flag" ? `FLAG "${out.reason}"`
            : kind === "proposal" ? `${out.ruleType} -> ${JSON.stringify(out.proposedValue)}`
              : "BOTH a proposal and a flag";
      const wanted = expected === null ? "nothing" : expected[0] === "FLAG" ? `FLAG ${expected[1]}` : `${expected[0]} -> ${JSON.stringify(expected[1])}`;
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${JSON.stringify(value)}\n        expected=${wanted}\n        actual=${actual}`);
    }
  }
}

console.log(`\n${checks - failures}/${checks} values matched (every value is checked; only listed ones are printed)`);
if (failures > 0) process.exitCode = 1;
