export const GET_METAFIELD_DEFINITIONS = `#graphql
  query GetMetafieldDefinitions(
    $ownerType: MetafieldOwnerType!
    $first: Int!
    $after: String
  ) {
    metafieldDefinitions(ownerType: $ownerType, first: $first, after: $after) {
      nodes {
        id
        name
        namespace
        key
        description
        type {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
