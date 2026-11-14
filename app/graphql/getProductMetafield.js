export const GET_PRODUCT_METAFIELD = `#graphql
  query GetProductMetafield($productId: ID!, $namespace: String!, $key: String!) {
    product(id: $productId) {
      id
      metafield(namespace: $namespace, key: $key) {
        value
        type
        compareDigest
      }
    }
  }
`;
