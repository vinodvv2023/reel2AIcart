import type { ActionFunctionArgs } from "@remix-run/node";

// PRD §5 + shopify.app.toml: 200 OK <100ms then enqueue to Modal. No long work here.
export async function action({ request }: ActionFunctionArgs) {
  const topic = request.headers.get("x-shopify-topic") ?? "unknown";
  // TODO Day 3-4: verify HMAC + fetch(`${MODAL_WEBHOOK_URL}/ingest`, {method:"POST", body})
  await request.text().catch(() => "");
  return Response.json({ ok: true, topic, enqueued: true });
}
