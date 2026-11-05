export const GET_PRODUCTS_WITH_METAFIELDS = `#graphql
  query GetProductsWithMetafields(
    $first: Int!
    $after: String
    $metafieldsFirst: Int!
  ) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        metafields(first: $metafieldsFirst) {
          nodes {
            namespace
            key
            value
            type
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
