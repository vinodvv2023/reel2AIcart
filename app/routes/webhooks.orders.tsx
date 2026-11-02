import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";

// PRD Pain 5: persists video_id for video→order reporting.
// Two callers: (1) native orders/create webhook (HMAC) — needs protected-
// data approval; (2) Shopify Flow "Send HTTP request" (x-flow-secret, no
// approval needed) with body {id, note_attributes[] | video_id}.
function pickId(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.split("/").pop());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const shop =
    request.headers.get("x-shopify-shop-domain") ??
    new URL(request.url).searchParams.get("shop") ??
    "";
  const topic = request.headers.get("x-shopify-topic") ?? "orders/flow";
  const raw = await request.text().catch(() => "");
  const viaFlow =
    Boolean(process.env.CRON_SECRET) &&
    request.headers.get("x-flow-secret") === process.env.CRON_SECRET;
  if (!viaFlow) {
    const hmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
    const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
      .update(raw, "utf8")
      .digest("base64");
    if (hmac && digest !== hmac) return json({ error: "bad hmac" }, { status: 401 });
  }

  let body: {
    id?: unknown;
    order_id?: unknown;
    video_id?: string;
    note_attributes?: { name: string; value: string }[];
  } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const orderId = pickId(body.order_id ?? body.id);
  const vid =
    body.video_id ??
    body.note_attributes?.find((a) => a.name === "_shopify_video")?.value ??
    null;
  try {
    const sql = db();
    await sql`INSERT INTO webhook_events (shop, topic, product_id, status, detail)
      VALUES (${shop}, ${topic}, null, ${vid ? "attributed" : "unattributed"}, ${`order=${orderId ?? "?"} video=${vid ?? "none"}`})`;
    if (vid && orderId)
      await sql`INSERT INTO order_attribution (order_id, shop, video_id)
        VALUES (${orderId}, ${shop}, ${vid}) ON CONFLICT (order_id) DO NOTHING`;
  } catch (e) {
    console.error("[orders] record failed:", String(e));
  }
  return json({ ok: true, video_id: vid });
}
