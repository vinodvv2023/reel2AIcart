import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";

// PRD §5 Step 2: Connect IG Graph + YouTube Data API + Commerce health check.
export async function loader() {
  const sample = "{{IE_30010}}";
  return json({ hint: humanizeCommerceError(sample) });
}

export default function Connect() {
  const { hint } = useLoaderData<typeof loader>();
  return (
    <main style={{ padding: 24 }}>
      <h1>Connect Instagram + YouTube</h1>
      <p>{hint}</p>
      <form method="post" action="/auth/instagram">
        <button type="submit">Connect Instagram</button>
      </form>
      <form method="post" action="/auth/youtube">
        <button type="submit">Connect YouTube</button>
      </form>
    </main>
  );
}
