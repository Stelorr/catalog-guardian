// Normalizer rules for the fix-proposal layer. proposeForField is pure: it
// takes one field's scanned values and returns proposals and flags, so
// scripts/test-normalize.js can exercise it without Prisma or Shopify.
//
// A rule only fires when the field has a clear majority pattern, and only
// proposes a change that is deterministic. Anything ambiguous is flagged
// instead of proposed. Values are never converted between units.
//
// v1 covers single-value metafields only. v2 candidates: list.* types
// (normalize each element) and product titles.

import prisma from "../db.server.js";

const MIN_SAMPLE = 5;
const DOMINANT_SHARE = 0.6;

const TEXT_TYPES = new Set(["single_line_text_field"]);
const MEASUREMENT_TYPES = new Set(["dimension", "weight", "volume"]);

// Lowercased unit spellings -> canonical unit. Only used to recognise two
// spellings of the same unit.
const UNIT_ALIASES = {
  in: "in", inch: "in", inches: "in", '"': "in",
  ft: "ft", foot: "ft", feet: "ft", "'": "ft",
  mm: "mm", millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm",
  cm: "cm", centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm",
  m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  g: "g", gram: "g", grams: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
};

const MEASUREMENT_RE = /^(-?\d+(?:\.\d+)?)(\s*)([A-Za-z]+\.?|"|')$/;

const STYLE_LABEL = { lower: "lower case", title: "Title Case", upper: "UPPER CASE" };

// Most common key and its count, from an array of keys.
function topCount(keys) {
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  let top = null;
  let topN = 0;
  let tied = false;
  for (const [k, n] of counts) {
    if (n > topN) [top, topN, tied] = [k, n, false];
    else if (n === topN) tied = true;
  }
  return { top, count: topN, tied, counts };
}

// --- UNIT: "10 in"-style text values -------------------------------------

function parseMeasurement(value) {
  const match = value.trim().match(MEASUREMENT_RE);
  if (!match) return null;
  const [, number, space, token] = match;
  const unit = UNIT_ALIASES[token.toLowerCase().replace(/\.$/, "")];
  if (!unit) return null;
  return { number, unit, token, format: `${space ? " " : ""}${token}` };
}

function describeUnparsed(value) {
  if (/\d\s*[x×]\s*\d/i.test(value)) return "looks like a compound value";
  if (/\d\s*-\s*\d/.test(value)) return "looks like a range";
  return "has extra text around the measurement";
}

// Returns null when the field isn't dominated by one measurement format, so
// the caller falls through to the naming and casing rules.
function textUnitRule(entries) {
  const parsed = entries.map((e) => parseMeasurement(e.value));
  const keys = parsed.filter(Boolean).map((p) => `${p.unit}|${p.format}`);
  const { top, count } = topCount(keys);
  if (!top || count < entries.length * DOMINANT_SHARE) return null;

  const [unit, format] = top.split("|");
  const label = `N${format}`;
  const result = { proposals: [], flags: [] };

  entries.forEach((entry, i) => {
    const p = parsed[i];
    if (!p) {
      result.flags.push({ entry, reason: `Doesn't match the majority format "${label}": ${describeUnparsed(entry.value)}` });
    } else if (p.unit !== unit) {
      result.flags.push({ entry, reason: `Different unit ("${p.token}") from the majority format "${label}"; units aren't converted` });
    } else {
      const proposed = `${p.number}${format}`;
      if (proposed !== entry.value) {
        result.proposals.push({
          entry,
          ruleType: "UNIT",
          proposedValue: proposed,
          ruleDetail: `Matches the majority unit format "${label}" (${count} of ${entries.length} values)`,
        });
      }
    }
  });
  return result;
}

// --- UNIT: dimension / weight / volume JSON values ------------------------

// Flag-only: the only fix for a minority unit is a conversion, and units
// aren't converted.
function jsonUnitRule(entries) {
  const units = entries.map((e) => {
    try {
      return JSON.parse(e.value)?.unit ?? null;
    } catch {
      return null;
    }
  });
  const { top, count } = topCount(units.filter(Boolean));
  const result = { proposals: [], flags: [] };
  if (!top || count < entries.length * DOMINANT_SHARE) return result;

  entries.forEach((entry, i) => {
    if (units[i] && units[i] !== top) {
      result.flags.push({ entry, reason: `Different unit (${units[i]}) from the majority ${top}; units aren't converted` });
    }
  });
  return result;
}

// --- NAMING and CASING: plain text values ---------------------------------

const collapseSpaces = (value) => value.trim().replace(/\s+/g, " ");
// Same words, ignoring case and separators: "Organic_Cotton" ~ "organic cotton".
const groupKey = (value) => value.trim().split(/[\s_\-/]+/).filter(Boolean).join(" ").toLowerCase();

function wordStyle(word) {
  if (!/[A-Za-z]/.test(word)) return null; // digits or punctuation only: neutral
  if (word === word.toLowerCase()) return "lower";
  if (/^[A-Z][^A-Z]*$/.test(word)) return "title";
  if (word === word.toUpperCase()) return "upper";
  return "mixed";
}

function valueStyle(value) {
  const styles = value.split(" ").map(wordStyle).filter(Boolean);
  if (styles.length === 0) return null;
  return styles.every((s) => s === styles[0]) ? styles[0] : "other";
}

// A word is safe to re-case only if it's plain ASCII letters in lower or
// Title form. Returns why it isn't, or null when it is.
function unsafeWordReason(word) {
  if (/[^\x20-\x7E]/.test(word)) return "has non-ASCII letters";
  if (/\d/.test(word) && /[A-Za-z]/.test(word)) return "mixes letters and digits";
  const style = wordStyle(word);
  if (style === "upper") return "is ALL CAPS (maybe an acronym)";
  if (style === "mixed") return "is mixed case (maybe a brand name)";
  return null;
}

function applyStyle(value, style) {
  return value
    .split(" ")
    .map((w) => {
      if (!/[A-Za-z]/.test(w)) return w;
      if (style === "lower") return w.toLowerCase();
      if (style === "upper") return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

function textNamingRule(entries) {
  const result = { proposals: [], flags: [] };
  const handled = new Set();

  // 1. Values with the same words as a more common spelling take that
  // spelling. The winner needs at least 2 uses and must beat every other
  // spelling outright; a tie proposes nothing.
  const groups = new Map();
  for (const entry of entries) {
    const key = groupKey(entry.value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const { top, count, tied } = topCount(group.map((e) => e.value));
    if (tied || count < 2) continue;
    for (const entry of group) {
      handled.add(entry);
      if (entry.value === top) continue;
      result.proposals.push({
        entry,
        ruleType: entry.value.toLowerCase() === top.toLowerCase() ? "CASING" : "NAMING",
        proposedValue: top,
        ruleDetail: `Matches the most common spelling "${top}" (${count} of ${group.length} similar values)`,
      });
    }
  }

  // 2. Everything else: collapse stray whitespace, and apply the field's
  // majority casing style when the value is made of plain words.
  //
  // Only values written entirely in one style are re-cased: all lowercase,
  // or all Title Case when the majority is lowercase. A mixed value such as
  // sentence case ("Bamboo core") is usually written that way on purpose, so
  // it's left alone.
  //
  // Known limitations:
  // - The majority counts occurrences, not distinct values, so one value
  //   repeated across many products ("Recycled Aluminum" x5) can make up
  //   most of it.
  // - A one-word value ("Wood") reads as Title Case and adds to that side of
  //   the vote, though it's equally valid sentence case.
  // - Brand names written in lowercase ("iphone blue") can't be told apart
  //   from plain words, so they'd be re-cased like any other word.
  const styles = entries.map((e) => valueStyle(collapseSpaces(e.value)));
  const { top: style, count: styleCount } = topCount(
    styles.filter((s) => s === "lower" || s === "title" || s === "upper"),
  );
  const dominantStyle = style && styleCount >= entries.length * DOMINANT_SHARE ? style : null;
  const canRecase = (valueStyleName) =>
    valueStyleName === "lower" || (valueStyleName === "title" && dominantStyle === "lower");

  entries.forEach((entry, i) => {
    if (handled.has(entry)) return;
    let proposed = collapseSpaces(entry.value);

    if (dominantStyle && styles[i] !== dominantStyle) {
      const unsafe = proposed
        .split(" ")
        .map((word) => [word, unsafeWordReason(word)])
        .find(([, reason]) => reason);
      if (unsafe) {
        result.flags.push({
          entry,
          reason: `"${unsafe[0]}" ${unsafe[1]}, so the majority ${STYLE_LABEL[dominantStyle]} style wasn't applied`,
        });
        return;
      }
      if (canRecase(styles[i])) proposed = applyStyle(proposed, dominantStyle);
    }

    if (proposed === entry.value) return;
    const spacesChanged = collapseSpaces(entry.value) !== entry.value;
    const styleDetail = `Matches the majority ${STYLE_LABEL[dominantStyle]} style (${styleCount} of ${entries.length} values)`;
    const caseChanged = proposed !== collapseSpaces(entry.value);
    result.proposals.push({
      entry,
      ruleType: spacesChanged ? "NAMING" : "CASING",
      proposedValue: proposed,
      ruleDetail: [spacesChanged && "Removes extra spaces", caseChanged && styleDetail]
        .filter(Boolean)
        .join("; "),
    });
  });

  return result;
}

// field: { namespace, key, type, values: [{ productId, productTitle, value }] }
// Pass only scanned values with status OK; MISSING, EMPTY and TYPE_MISMATCH
// rows never get proposals.
export function proposeForField(field) {
  const entries = field.values.filter((v) => typeof v.value === "string" && v.value.trim() !== "");
  let result = { proposals: [], flags: [] };

  if (entries.length >= MIN_SAMPLE) {
    if (MEASUREMENT_TYPES.has(field.type)) {
      result = jsonUnitRule(entries);
    } else if (TEXT_TYPES.has(field.type)) {
      result = textUnitRule(entries) ?? textNamingRule(entries);
    }
  }

  return {
    proposals: result.proposals.map(({ entry, ...rest }) => ({
      productId: entry.productId,
      productTitle: entry.productTitle,
      originalValue: entry.value,
      ...rest,
    })),
    flags: result.flags.map(({ entry, reason }) => ({ productId: entry.productId, reason })),
  };
}

const targetKey = (p) => `${p.productId}|${p.namespace}|${p.key}`;

// Regenerates this shop's proposals from one completed scan run. Only
// PENDING proposals are replaced; decided ones are never touched. A target
// that already has an APPROVED proposal gets no new one, and a proposal the
// merchant REJECTED isn't recreated unless the value has changed since.
// Expects the scan's upsert to have reset flagReason to null on its rows.
export async function generateProposals({ shop, scanRunId }) {
  const rows = await prisma.scanResult.findMany({
    where: { shop, scanRunId, status: "OK" },
  });

  const fields = new Map();
  for (const row of rows) {
    const id = `${row.namespace}.${row.key}`;
    if (!fields.has(id)) {
      fields.set(id, { namespace: row.namespace, key: row.key, type: row.expectedType, values: [] });
    }
    fields.get(id).values.push({
      productId: row.productId,
      productTitle: row.productTitle,
      value: row.actualValue,
    });
  }

  const decided = await prisma.fixProposal.findMany({
    where: { shop, status: { in: ["APPROVED", "REJECTED"] } },
    select: { productId: true, namespace: true, key: true, status: true, originalValue: true, proposedValue: true },
  });
  const approvedTargets = new Set(decided.filter((d) => d.status === "APPROVED").map(targetKey));
  const rejected = new Set(
    decided
      .filter((d) => d.status === "REJECTED")
      .map((d) => `${targetKey(d)}|${d.originalValue}|${d.proposedValue}`),
  );

  const proposals = [];
  const flags = [];
  for (const field of fields.values()) {
    const { namespace, key, type } = field;
    const result = proposeForField(field);

    for (const p of result.proposals) {
      const proposal = { shop, namespace, key, valueType: type, scanRunId, ...p };
      if (approvedTargets.has(targetKey(proposal))) continue;
      if (rejected.has(`${targetKey(proposal)}|${p.originalValue}|${p.proposedValue}`)) continue;
      proposals.push(proposal);
    }
    for (const f of result.flags) flags.push({ namespace, key, ...f });
  }

  await prisma.$transaction([
    prisma.fixProposal.deleteMany({ where: { shop, status: "PENDING" } }),
    prisma.fixProposal.createMany({ data: proposals }),
    ...flags.map((f) =>
      prisma.scanResult.update({
        where: {
          shop_productId_namespace_key: { shop, productId: f.productId, namespace: f.namespace, key: f.key },
        },
        data: { flagReason: f.reason },
      }),
    ),
  ]);

  return { proposals: proposals.length, flags: flags.length };
}
