import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";

// PRD Pain 5: orders/create persists video_id for video→order reporting.
// Path: widget sets _shopify_video cookie → cart attribute →
// order note_attributes → here → order_attribution (+ dashboard log).
export async function action({ request }: ActionFunctionArgs) {
  const shop = request.headers.get("x-shopify-shop-domain") ?? "";
  const topic = request.headers.get("x-shopify-topic") ?? "orders/create";
  const raw = await request.text().catch(() => "");
  const hmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(raw, "utf8")
    .digest("base64");
  if (hmac && digest !== hmac) return json({ error: "bad hmac" }, { status: 401 });

  let order: { id?: number; note_attributes?: { name: string; value: string }[] } = {};
  try {
    order = JSON.parse(raw) as typeof order;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const vid =
    order.note_attributes?.find((a) => a.name === "_shopify_video")?.value ?? null;
  try {
    const sql = db();
    await sql`INSERT INTO webhook_events (shop, topic, product_id, status, detail)
      VALUES (${shop}, ${topic}, null, ${vid ? "attributed" : "unattributed"}, ${`order=${order.id ?? "?"} video=${vid ?? "none"}`})`;
    if (vid && order.id)
      await sql`INSERT INTO order_attribution (order_id, shop, video_id)
        VALUES (${order.id}, ${shop}, ${vid}) ON CONFLICT (order_id) DO NOTHING`;
  } catch (e) {
    console.error("[orders] record failed:", String(e));
  }
  return json({ ok: true, video_id: vid });
}
