export const SET_PRODUCT = `#graphql
  mutation SetProduct($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product {
        id
        handle
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;
