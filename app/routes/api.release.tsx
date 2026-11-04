import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { db } from "~/lib/db";

// HITL release: unfreezes verified rows (single hash or all) so the next
// scan or re-save may re-enrich them. Frozen is the default; every release
// is an explicit click. Redirects back to the dashboard.
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const shop = String(form.get("shop") ?? "");
  const hash = String(form.get("video_hash") ?? "");
  const all = String(form.get("all") ?? "") === "1";
  const back = String(form.get("from") ?? "") === "scan" ? "/scan" : "/";
  const sql = db();
  if (all) {
    await sql`UPDATE video_embeddings SET verified = FALSE WHERE verified`;
  } else if (hash) {
    await sql`UPDATE video_embeddings SET verified = FALSE WHERE video_hash = ${hash}`;
  }
  return redirect(shop ? `${back}?shop=${encodeURIComponent(shop)}` : back);
}
