import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";

// PRD §5 + shopify.app.toml: 200 OK <100ms then enqueue to Modal. No long work here.
// Every delivery is logged (console → Vercel logs) and recorded in
// webhook_events (→ home dashboard), so silent failures are visible.
async function record(event: {
  shop: string;
  topic: string;
  product_id: number | null;
  status: string;
  detail: string;
}) {
  console.log(`[webhook] ${event.topic} shop=${event.shop} status=${event.status} ${event.detail}`);
  try {
    const sql = db();
    await sql`INSERT INTO webhook_events (shop, topic, product_id, status, detail)
      VALUES (${event.shop}, ${event.topic}, ${event.product_id}, ${event.status}, ${event.detail})`;
  } catch (e) {
    console.error("[webhook] record failed:", String(e));
  }
}
export async function action({ request }: ActionFunctionArgs) {
  const topic = request.headers.get("x-shopify-topic") ?? "unknown";
  const shop = request.headers.get("x-shopify-shop-domain") ?? "";
  const raw = await request.text().catch(() => "");
  const hmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(raw, "utf8")
    .digest("base64");
  if (hmac && digest !== hmac) {
    await record({ shop, topic, product_id: null, status: "rejected", detail: "bad hmac" });
    return json({ error: "bad hmac" }, { status: 401 });
  }
  if (process.env.MODAL_WEBHOOK_URL) {
    // Shape a minimal enrichment payload: product id + hero images.
    // video_url needs product-media GraphQL + stored shop token (TODO) —
    // until then Modal skips media-less payloads instead of writing junk rows.
    let payload: Record<string, unknown> = {};
    try {
      const p = JSON.parse(raw) as {
        id?: number;
        image?: { src?: string };
        images?: { src?: string }[];
      };
      const hero = [...(p.images ?? []).map((i) => i.src).filter(Boolean)];
      if (p.image?.src && !hero.includes(p.image.src)) hero.unshift(p.image.src);
      payload = {
        shop: request.headers.get("x-shopify-shop-domain") ?? "",
        topic,
        product_id: p.id ?? null,
        video_url: "",
        hero_images: hero.slice(0, 3),
        secret: process.env.MODAL_INGEST_SECRET ?? "",
      };
    } catch {
      payload = { topic, product_id: null, video_url: "", hero_images: [] };
    }
    const productId =
      typeof payload.product_id === "number" ? payload.product_id : null;
    // HITL frozen copies: a verified row never re-enriches without Release.
    // Unverified rows still refresh on re-save (PDP backfill path).
    if (productId !== null) {
      try {
        const sql = db();
        const rows = (await sql`SELECT verified FROM video_embeddings
          WHERE summary->>'product_id' = ${String(productId)} LIMIT 1`) as { verified: boolean }[];
        if (rows.length && rows[0].verified) {
          await record({ shop, topic, product_id: productId, status: "held-verified", detail: "frozen copy kept" });
          return json({ ok: true, topic, enqueued: false });
        }
      } catch {
        // check failed open: forward rather than drop the event
      }
    }
    if (!process.env.MODAL_WEBHOOK_URL) {
      await record({ shop, topic, product_id: productId, status: "failed", detail: "MODAL_WEBHOOK_URL missing" });
      return json({ ok: true, topic, enqueued: false });
    }
    try {
      const res = await fetch(process.env.MODAL_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await record({
        shop, topic, product_id: productId,
        status: res.ok ? "forwarded" : "failed",
        detail: `modal ${res.status} hero=${(payload.hero_images as unknown[]).length}`,
      });
    } catch (e) {
      await record({ shop, topic, product_id: productId, status: "failed", detail: `modal fetch: ${String(e)}` });
    }
  }
  return json({ ok: true, topic, enqueued: true });
}
