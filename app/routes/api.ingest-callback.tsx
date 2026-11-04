import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";

// Modal outcome callback: enrich_video POSTs here on every exit path
// (enriched | skipped | failed). Auth is the shared MODAL_INGEST_SECRET,
// same secret as the Vercel -> Modal direction. Moves ingest_jobs rows
// from 'sent' to terminal state so the dashboard shows outcomes, not guesses.
const TERMINAL = ["enriched", "skipped", "failed"];

export async function action({ request }: ActionFunctionArgs) {
  let body: { job_key?: string; status?: string; detail?: string; secret?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const envSecret = process.env.MODAL_INGEST_SECRET ?? "";
  if (!envSecret || body.secret !== envSecret) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const key = String(body.job_key ?? "");
  const status = String(body.status ?? "");
  if (!key || !TERMINAL.includes(status)) {
    return json({ ok: false, error: "job_key + terminal status required" }, { status: 400 });
  }
  try {
    const sql = db();
    const rows = (await sql`UPDATE ingest_jobs SET status = ${status},
      detail = ${String(body.detail ?? "").slice(0, 300)}, updated_at = NOW()
      WHERE job_key = ${key} RETURNING id`) as { id: number }[];
    if (!rows.length) return json({ ok: false, error: "unknown job_key" }, { status: 404 });
    return json({ ok: true, id: rows[0].id, status });
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}
