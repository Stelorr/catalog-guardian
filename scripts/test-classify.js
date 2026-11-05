import { classifyMetafield } from "../app/services/scanEngine.server.js";

function definition(namespace, key, typeName) {
  return { namespace, key, type: { name: typeName } };
}

function metafield(namespace, key, value, typeName) {
  return { namespace, key, value, type: typeName };
}

const cases = [
  {
    name: "MISSING — no metafield at all on the product",
    definition: definition("custom", "material", "single_line_text_field"),
    metafield: undefined,
    expectedStatus: "MISSING",
  },
  {
    name: "MISSING — metafield present but value is null",
    definition: definition("custom", "material", "single_line_text_field"),
    metafield: metafield("custom", "material", null, "single_line_text_field"),
    expectedStatus: "MISSING",
  },
  {
    name: "EMPTY — value is a blank string",
    definition: definition("custom", "care_instructions", "multi_line_text_field"),
    metafield: metafield("custom", "care_instructions", "", "multi_line_text_field"),
    expectedStatus: "EMPTY",
  },
  {
    name: "EMPTY — value is whitespace only",
    definition: definition("custom", "care_instructions", "multi_line_text_field"),
    metafield: metafield("custom", "care_instructions", "   ", "multi_line_text_field"),
    expectedStatus: "EMPTY",
  },
  {
    name: "TYPE_MISMATCH — Shopify type differs from the definition's type",
    definition: definition("custom", "material", "single_line_text_field"),
    metafield: metafield("custom", "material", "Cotton", "multi_line_text_field"),
    expectedStatus: "TYPE_MISMATCH",
  },
  {
    name: "TYPE_MISMATCH — integer definition holds a non-numeric string",
    definition: definition("custom", "weight_g", "number_integer"),
    metafield: metafield("custom", "weight_g", "heavy", "number_integer"),
    expectedStatus: "TYPE_MISMATCH",
  },
  {
    name: "TYPE_MISMATCH — list definition holds invalid JSON",
    definition: definition("custom", "sizes", "list.single_line_text_field"),
    metafield: metafield("custom", "sizes", "not json", "list.single_line_text_field"),
    expectedStatus: "TYPE_MISMATCH",
  },
  {
    name: "OK — matching text value",
    definition: definition("custom", "material", "single_line_text_field"),
    metafield: metafield("custom", "material", "Cotton", "single_line_text_field"),
    expectedStatus: "OK",
  },
  {
    name: "OK — matching integer value",
    definition: definition("custom", "weight_g", "number_integer"),
    metafield: metafield("custom", "weight_g", "450", "number_integer"),
    expectedStatus: "OK",
  },
  {
    name: "OK — list definition holds a valid JSON array",
    definition: definition("custom", "sizes", "list.single_line_text_field"),
    metafield: metafield("custom", "sizes", '["S","M","L"]', "list.single_line_text_field"),
    expectedStatus: "OK",
  },
  {
    name: "EMPTY — list definition holds an empty array",
    definition: definition("custom", "sizes", "list.single_line_text_field"),
    metafield: metafield("custom", "sizes", "[]", "list.single_line_text_field"),
    expectedStatus: "EMPTY",
  },
  {
    name: "EMPTY — json definition holds an empty object",
    definition: definition("custom", "specs", "json"),
    metafield: metafield("custom", "specs", "{}", "json"),
    expectedStatus: "EMPTY",
  },
  {
    name: "OK — json definition holds a populated object",
    definition: definition("custom", "specs", "json"),
    metafield: metafield("custom", "specs", '{"color":"red"}', "json"),
    expectedStatus: "OK",
  },
];

let failures = 0;

for (const testCase of cases) {
  const result = classifyMetafield(testCase.definition, testCase.metafield);
  const pass = result.status === testCase.expectedStatus;
  if (!pass) failures++;

  console.log(
    `${pass ? "PASS" : "FAIL"}  ${testCase.name}\n` +
      `      expected=${testCase.expectedStatus} actual=${result.status} actualValue=${JSON.stringify(result.actualValue)}`,
  );
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) process.exitCode = 1;
