import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";

// Attribution via polling: orders/* webhooks carry protected customer data
// and need Shopify approval, so Vercel Cron hits this every 15 min instead.
// Admin API reads only need read_orders (no approval). webhooks.orders stays
// in place for post-approval switch-over. Set CRON_SECRET in Vercel env.
export async function loader({ request }: LoaderFunctionArgs) {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return json({ error: "unauthorized" }, { status: 401 });
  const sql = db();
  const shops = (await sql`SELECT shop, access_token FROM shops`) as {
    shop: string;
    access_token: string;
  }[];
  const since = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  let scanned = 0,
    attributed = 0;
  const errors: string[] = [];
  for (const { shop, access_token } of shops) {
    // GraphQL field-level read: id + noteAttributes only, no customer PII,
    // so it may pass without protected-data approval (REST orders is gated).
    const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": access_token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($q: String!) { orders(first: 50, query: $q) {
          edges { node { id noteAttributes { name value } } } } }`,
        variables: { q: `updated_at:>=${since}` },
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      errors.push(`${shop}: shopify ${res.status} ${body}`);
      continue;
    }
    const gql = (await res.json()) as {
      data?: { orders: { edges: { node: { id: string; noteAttributes: { name: string; value: string }[] } }[] } };
      errors?: { message: string }[];
    };
    if (gql.errors?.length || !gql.data) {
      errors.push(`${shop}: graphql ${(gql.errors ?? []).map((e) => e.message).join("; ").slice(0, 200)}`);
      continue;
    }
    for (const { node } of gql.data.orders.edges) {
      scanned++;
      const vid = node.noteAttributes?.find((a) => a.name === "_shopify_video")?.value;
      if (!vid) continue;
      const orderId = Number(node.id.split("/").pop());
      await sql`INSERT INTO order_attribution (order_id, shop, video_id)
        VALUES (${orderId}, ${shop}, ${vid}) ON CONFLICT (order_id) DO NOTHING`;
      attributed++;
    }
  }
  return json({ ok: true, shops: shops.length, scanned, attributed, errors });
}
