import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { db } from "~/lib/db";

// Scan monitor: progress, completion banner, verified review queue.
// Auto-refreshes every 30s only while a job is open (meta refresh, no JS).
export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const job = (data as { job?: { status?: string } } | undefined)?.job;
  const open = job && (job.status === "queued" || job.status === "running");
  return open ? [{ "http-equiv": "refresh", content: "30" }] : [];
};

type ScanJob = { id: number; shop: string; status: string; scanned: number; enqueued: number; skipped_verified: number; error: string };

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  let job: ScanJob | null = null;
  let frozen: { video_hash: string; url: string; vision: string }[] = [];
  try {
    const sql = db();
    const rows = (await (shop
      ? sql`SELECT id, shop, status, scanned, enqueued, skipped_verified, error FROM scan_jobs WHERE shop = ${shop} ORDER BY id DESC LIMIT 1`
      : sql`SELECT id, shop, status, scanned, enqueued, skipped_verified, error FROM scan_jobs ORDER BY id DESC LIMIT 1`)) as ScanJob[];
    job = rows[0] ?? null;
    frozen = (await sql`SELECT video_hash, summary->>'video_url' AS url, summary->'providers'->>'vision' AS vision
      FROM video_embeddings WHERE verified ORDER BY video_hash LIMIT 50`) as typeof frozen;
  } catch {
    // render empty on DB failure
  }
  return json({ shop, job, frozen });
}

export default function Scan() {
  const { shop, job, frozen } = useLoaderData<typeof loader>();
  const open = job && (job.status === "queued" || job.status === "running");
  return (
    <main className="r2ac-wrap">
      <header className="r2ac-brand" aria-label="Reel2AICart">
        <span className="r2ac-mark" aria-hidden="true" />
        <strong style={{ fontSize: 22, color: "#0f4c4a" }}>
          Reel2<span style={{ color: "#ff7a5c" }}>AI</span>Cart
        </strong>
      </header>
      <section className="r2ac-card" style={{ marginTop: 16 }}>
        <h2>Catalog scan {shop ? <small>for {shop}</small> : null}</h2>
        {!job ? (
          <p><small>No scans yet.</small></p>
        ) : open ? (
          <p><small>Job #{job.id} {job.status} (auto-refreshes every 30s) — {job.scanned} scanned, {job.enqueued} enqueued, {job.skipped_verified} held for review.</small></p>
        ) : job.status === "done" ? (
          <p className="r2ac-ok"><small>Job #{job.id} complete — {job.scanned} scanned, {job.enqueued} enqueued, {job.skipped_verified} held for review.</small></p>
        ) : (
          <p className="r2ac-err"><small>Job #{job.id} failed: {job.error}</small></p>
        )}
        <p><a className="btn btn-ghost" href={shop ? `/?shop=${encodeURIComponent(shop)}` : "/"}>Back to dashboard</a></p>
      </section>
      {frozen.length > 0 && (
        <section className="r2ac-card" style={{ marginTop: 12 }}>
          <h3>Verified rows (frozen)</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {frozen.map((r) => (
              <li key={r.video_hash}>
                <small><code>{r.video_hash.slice(0, 12)}…</code> {r.url} ({r.vision})</small>{" "}
                <Form method="post" action="/api/release" style={{ display: "inline" }}>
                  <input type="hidden" name="shop" value={shop} />
                  <input type="hidden" name="from" value="scan" />
                  <input type="hidden" name="video_hash" value={r.video_hash} />
                  <button type="submit">Release</button>
                </Form>
              </li>
            ))}
          </ul>
          <Form method="post" action="/api/release" style={{ marginTop: 8 }}>
            <input type="hidden" name="shop" value={shop} />
            <input type="hidden" name="from" value="scan" />
            <input type="hidden" name="all" value="1" />
            <button type="submit">Release all</button>
          </Form>
        </section>
      )}
    </main>
  );
}
