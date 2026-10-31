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
    fetch(process.env.MODAL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }).catch(() => {});
  }
  return json({ ok: true, topic, enqueued: true });
}
