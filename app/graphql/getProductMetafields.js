export const GET_PRODUCT_METAFIELDS = `#graphql
  query GetProductMetafields($productId: ID!, $first: Int!, $after: String) {
    product(id: $productId) {
      id
      metafields(first: $first, after: $after) {
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
  }
`;
