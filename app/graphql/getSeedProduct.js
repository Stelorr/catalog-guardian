export const GET_SEED_PRODUCT = `#graphql
  query GetSeedProduct($handle: String!, $namespace: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      handle
      title
      tags
      metafields(first: 20, namespace: $namespace) {
        nodes {
          key
          value
          type
        }
      }
    }
  }
`;
