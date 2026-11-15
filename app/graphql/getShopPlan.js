export const GET_SHOP_PLAN = `#graphql
  query GetShopPlan {
    shop {
      myshopifyDomain
      plan {
        partnerDevelopment
      }
    }
  }
`;
