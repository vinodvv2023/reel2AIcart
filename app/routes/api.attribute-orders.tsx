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
    const res = await fetch(
      `https://${shop}/admin/api/2026-10/orders.json?limit=100&updated_at_min=${encodeURIComponent(since)}&fields=id,note_attributes`,
      { headers: { "X-Shopify-Access-Token": access_token } },
    );
    if (!res.ok) {
      errors.push(`${shop}: shopify ${res.status}`);
      continue;
    }
    const { orders } = (await res.json()) as {
      orders: { id: number; note_attributes?: { name: string; value: string }[] }[];
    };
    for (const o of orders) {
      scanned++;
      const vid = o.note_attributes?.find((a) => a.name === "_shopify_video")?.value;
      if (!vid) continue;
      await sql`INSERT INTO order_attribution (order_id, shop, video_id)
        VALUES (${o.id}, ${shop}, ${vid}) ON CONFLICT (order_id) DO NOTHING`;
      attributed++;
    }
  }
  return json({ ok: true, shops: shops.length, scanned, attributed, errors });
}
