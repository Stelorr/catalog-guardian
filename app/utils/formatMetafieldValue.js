// Display text for a stored metafield value. Weight, dimension and volume
// values are JSON like {"value":1500.0,"unit":"GRAMS"}; everything else
// (and anything that doesn't parse) is shown exactly as stored.
const MEASUREMENT_TYPES = new Set(["weight", "dimension", "volume"]);

// One flat map: Shopify's unit names are unique across the three types.
const UNIT_LABELS = {
  GRAMS: "g", KILOGRAMS: "kg", OUNCES: "oz", POUNDS: "lb",
  INCHES: "in", FEET: "ft", YARDS: "yd", MILLIMETERS: "mm", CENTIMETERS: "cm", METERS: "m",
  MILLILITERS: "ml", CENTILITERS: "cl", LITERS: "l", CUBIC_METERS: "m³",
  FLUID_OUNCES: "fl oz", PINTS: "pt", QUARTS: "qt", GALLONS: "gal",
  IMPERIAL_FLUID_OUNCES: "imp fl oz", IMPERIAL_PINTS: "imp pt",
  IMPERIAL_QUARTS: "imp qt", IMPERIAL_GALLONS: "imp gal",
};

function unitLabel(unit) {
  const upper = unit.toUpperCase();
  // Unknown names stay readable ("SQUARE_FEET" -> "square feet"); short
  // forms Shopify may already return ("kg") pass through.
  return UNIT_LABELS[upper] ?? unit.toLowerCase().replace(/_/g, " ");
}

export function formatMetafieldValue(type, value) {
  if (value == null || !MEASUREMENT_TYPES.has(type)) return value;

  try {
    const parsed = JSON.parse(value);
    const number = Number(parsed?.value);
    if (typeof parsed?.unit !== "string" || parsed.unit === "" || !Number.isFinite(number)) {
      return value;
    }
    return `${number} ${unitLabel(parsed.unit)}`;
  } catch {
    return value;
  }
}

// One line naming a fix from an apply result, e.g.
// Cotton Hoodie · color: "sage green" → "Sage Green"
export function describeFix({ productTitle, key, valueType, originalValue, proposedValue }) {
  const before = formatMetafieldValue(valueType, originalValue);
  const after = formatMetafieldValue(valueType, proposedValue);
  return `${productTitle} · ${key}: "${before}" → "${after}"`;
}
