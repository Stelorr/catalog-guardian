// Human-readable labels for Shopify's raw metafield type strings. Shared
// between the Issues dashboard and (per Phase 7) the bulk-fix modal, so it
// lives here rather than inline in a single route.
const BASE_TYPE_LABELS = {
  single_line_text_field: "Single line text",
  multi_line_text_field: "Multi-line text",
  rich_text_field: "Rich text",
  number_integer: "Integer",
  number_decimal: "Decimal number",
  boolean: "True or false",
  json: "JSON",
  date: "Date",
  date_time: "Date and time",
  url: "URL",
  color: "Color",
  rating: "Rating",
  money: "Money",
  dimension: "Dimension",
  volume: "Volume",
  weight: "Weight",
  id: "ID",
  language: "Language",
  link: "Link",
  article_reference: "Article reference",
  collection_reference: "Collection reference",
  company_reference: "Company reference",
  customer_reference: "Customer reference",
  file_reference: "File reference",
  metaobject_reference: "Metaobject reference",
  mixed_reference: "Mixed reference",
  order_reference: "Order reference",
  page_reference: "Page reference",
  product_reference: "Product reference",
  product_taxonomy_value_reference: "Product category reference",
  variant_reference: "Variant reference",
};

// Sentence-cases an unmapped raw type (e.g. "antenna_gain" -> "Antenna
// gain") so a type Shopify adds later still renders as something readable
// instead of nothing.
function humanizeFallback(rawType) {
  const words = rawType.split("_");
  return words.map((word, i) => (i === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word)).join(" ");
}

export function getMetafieldTypeLabel(rawType) {
  if (!rawType) return "Unknown type";

  if (rawType.startsWith("list.")) {
    const baseType = rawType.slice("list.".length);
    return `List of ${getMetafieldTypeLabel(baseType).toLowerCase()}`;
  }

  return BASE_TYPE_LABELS[rawType] ?? humanizeFallback(rawType);
}

// Which bulk-fix input widget a raw type should render. Only the common
// scalar types get a dedicated widget; everything else (list.*, rich text,
// references, and the many physical-unit/JSON-shaped types) falls back to
// a plain text field for the raw value — see Phase 7 notes for why.
const INPUT_KIND_BY_TYPE = {
  single_line_text_field: "text",
  multi_line_text_field: "textarea",
  number_integer: "integer",
  number_decimal: "decimal",
  boolean: "boolean",
  url: "url",
  date: "date",
};

export function getMetafieldInputKind(rawType) {
  if (!rawType || rawType.startsWith("list.")) return "generic";
  return INPUT_KIND_BY_TYPE[rawType] ?? "generic";
}
