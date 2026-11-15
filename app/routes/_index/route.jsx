import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Landing() {
  const { showForm } = useLoaderData();
  const [shop, setShop] = useState("");

  return (
    <AppProvider embedded={false}>
      <s-page heading="Catalog Guardian">
        <s-section heading="Clean up inconsistent metafield data">
          <s-paragraph>
            Catalog Guardian scans your products against your metafield definitions,
            finds values that are missing, empty or written inconsistently (&quot;10in&quot;,
            &quot;12 inches&quot;, &quot;10 IN&quot;), and proposes safe fixes you approve one by one.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>Scan every product against its metafield definitions.</s-list-item>
            <s-list-item>
              Review proposed unit, casing and naming fixes, and approve or reject each one.
            </s-list-item>
            <s-list-item>
              Apply approved fixes safely: anything edited in Shopify since the scan is
              skipped, never overwritten.
            </s-list-item>
          </s-unordered-list>
        </s-section>

        {showForm && (
          <Form method="post" action="/auth/login">
            <s-section heading="Open the app">
              <s-text-field
                name="shop"
                label="Shop domain"
                details="example.myshopify.com"
                value={shop}
                onChange={(e) => setShop(e.currentTarget.value)}
              ></s-text-field>
              <s-button type="submit" variant="primary">
                Log in
              </s-button>
            </s-section>
          </Form>
        )}
      </s-page>
    </AppProvider>
  );
}
