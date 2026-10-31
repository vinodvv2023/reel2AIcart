import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

// PRD §5 + shopify.app.toml: 200 OK <100ms then enqueue to Modal. No long work here.
export async function action({ request }: ActionFunctionArgs) {
  const topic = request.headers.get("x-shopify-topic") ?? "unknown";
  const raw = await request.text().catch(() => "");
  const hmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(raw, "utf8")
    .digest("base64");
  if (hmac && digest !== hmac) return json({ error: "bad hmac" }, { status: 401 });
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
      };
    } catch {
      payload = { topic, product_id: null, video_url: "", hero_images: [] };
    }
    fetch(process.env.MODAL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
  return json({ ok: true, topic, enqueued: true });
}
