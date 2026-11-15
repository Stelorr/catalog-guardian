import { describeFix, formatMetafieldValue } from "../app/utils/formatMetafieldValue.js";

// [type, stored value, expected display text]
const cases = [
  ["weight", '{"value":1500.0,"unit":"GRAMS"}', "1500 g"],
  ["weight", '{"value":2.0,"unit":"POUNDS"}', "2 lb"],
  ["weight", '{"value":2.5,"unit":"KILOGRAMS"}', "2.5 kg"],
  ["weight", '{"value":8,"unit":"OUNCES"}', "8 oz"],
  ["dimension", '{"value":25.4,"unit":"CENTIMETERS"}', "25.4 cm"],
  ["dimension", '{"value":10.0,"unit":"INCHES"}', "10 in"],
  ["volume", '{"value":750.0,"unit":"MILLILITERS"}', "750 ml"],
  ["volume", '{"value":1,"unit":"FLUID_OUNCES"}', "1 fl oz"],
  // Short units pass through, unknown names are made readable.
  ["weight", '{"value":3,"unit":"kg"}', "3 kg"],
  ["dimension", '{"value":4,"unit":"SQUARE_FEET"}', "4 square feet"],
  // Anything else is shown exactly as stored.
  ["weight", "not json", "not json"],
  ["weight", '{"value":"heavy","unit":"GRAMS"}', '{"value":"heavy","unit":"GRAMS"}'],
  ["weight", '{"value":5}', '{"value":5}'],
  ["weight", '{"value":5,"unit":""}', '{"value":5,"unit":""}'],
  ["weight", "[1,2]", "[1,2]"],
  ["single_line_text_field", '{"value":1,"unit":"GRAMS"}', '{"value":1,"unit":"GRAMS"}'],
  ["single_line_text_field", "10 in", "10 in"],
  ["json", '{"value":1,"unit":"GRAMS"}', '{"value":1,"unit":"GRAMS"}'],
  ["weight", null, null],
];

let failures = 0;
for (const [type, value, expected] of cases) {
  const actual = formatMetafieldValue(type, value);
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${type.padEnd(22)} ${JSON.stringify(value)} -> ${JSON.stringify(actual)}${pass ? "" : `  (expected ${JSON.stringify(expected)})`}`);
}

// [apply result, expected line]
const fixCases = [
  [
    { productTitle: "Cotton Hoodie", key: "color", valueType: "single_line_text_field", originalValue: "sage green", proposedValue: "Sage Green" },
    'Cotton Hoodie · color: "sage green" → "Sage Green"',
  ],
  [
    { productTitle: "Linen Shirt", key: "width", valueType: "single_line_text_field", originalValue: "10in", proposedValue: "10 in" },
    'Linen Shirt · width: "10in" → "10 in"',
  ],
  [
    { productTitle: "Denim Jacket", key: "weight", valueType: "weight", originalValue: '{"value":1500.0,"unit":"GRAMS"}', proposedValue: '{"value":1.5,"unit":"KILOGRAMS"}' },
    'Denim Jacket · weight: "1500 g" → "1.5 kg"',
  ],
];

for (const [result, expected] of fixCases) {
  const actual = describeFix(result);
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  describeFix -> ${actual}${pass ? "" : `  (expected ${expected})`}`);
}

const total = cases.length + fixCases.length;
console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exitCode = 1;
