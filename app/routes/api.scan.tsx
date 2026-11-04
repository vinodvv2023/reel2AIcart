import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { db } from "~/lib/db";

// Enqueue a catalog scan (backfill without manual re-saves). Creates one
// scan_jobs row; the cron worker does the paging. Idempotent per shop:
// an already queued/running job is returned instead of duplicated.
// HTML form posts redirect back to the dashboard; JSON callers get the id.
export async function action({ request }: ActionFunctionArgs) {
  const ct = request.headers.get("content-type") ?? "";
  let shop = "";
  let viaForm = false;
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { shop?: string };
    shop = String(body.shop ?? "");
  } else {
    const form = await request.formData();
    shop = String(form.get("shop") ?? "");
    viaForm = true;
  }
  if (!shop) {
    if (viaForm) return redirect("/");
    return json({ ok: false, error: "shop required" }, { status: 400 });
  }
  const sql = db();
  const tokens = (await sql`SELECT 1 FROM shops WHERE shop = ${shop} LIMIT 1`) as unknown[];
  if (!tokens.length) {
    if (viaForm) return redirect("/");
    return json({ ok: false, error: "shop not installed" }, { status: 404 });
  }
  const open = (await sql`SELECT id FROM scan_jobs WHERE shop = ${shop}
    AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`) as { id: number }[];
  if (viaForm) {
    if (!open.length) {
      await sql`INSERT INTO scan_jobs (shop) VALUES (${shop})`;
    }
    return redirect(`/?shop=${encodeURIComponent(shop)}`);
  }
  if (open.length) return json({ ok: true, job_id: open[0].id, resumed: true });
  const rows = (await sql`INSERT INTO scan_jobs (shop) VALUES (${shop})
    RETURNING id`) as { id: number }[];
  return json({ ok: true, job_id: rows[0].id });
}
