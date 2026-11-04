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
  let quality: { v: string; n: number }[] = [];
  try {
    const sql = db();
    const [rows, fz, qy] = await Promise.all([
      (async () => (await (shop
        ? sql`SELECT id, shop, status, scanned, enqueued, skipped_verified, error FROM scan_jobs WHERE shop = ${shop} ORDER BY id DESC LIMIT 1`
        : sql`SELECT id, shop, status, scanned, enqueued, skipped_verified, error FROM scan_jobs ORDER BY id DESC LIMIT 1`)) as ScanJob[])(),
      sql`SELECT video_hash, summary->>'video_url' AS url, summary->'providers'->>'vision' AS vision
        FROM video_embeddings WHERE verified ORDER BY video_hash LIMIT 50`,
      sql`SELECT summary->'providers'->>'vision' AS v, COUNT(*)::int AS n
        FROM video_embeddings GROUP BY 1`,
    ]);
    job = rows[0] ?? null;
    frozen = fz as typeof frozen;
    quality = qy as typeof quality;
  } catch {
    // render empty on DB failure
  }
  return json({ shop, job, frozen, quality });
}

export default function Scan() {
  const { shop, job, frozen, quality } = useLoaderData<typeof loader>();
  const open = job && (job.status === "queued" || job.status === "running");
  const muse = quality.find((r) => r.v === "muse-spark-vision-v1")?.n ?? 0;
  const heur = quality.filter((r) => r.v !== "muse-spark-vision-v1").reduce((s, r) => s + r.n, 0);
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
          <p><small>Scan in progress (this page refreshes itself) — checked {job.scanned} items so far, {job.enqueued} sent for image and video analysis{job.skipped_verified > 0 ? `, ${job.skipped_verified} need your review below` : ""}.</small></p>
        ) : job.status === "done" ? (
          <>
            <p className="r2ac-ok"><small>Scan complete. All done — nothing left for you to do{job.skipped_verified > 0 ? " except the review items below" : ""}.</small></p>
            <ul style={{ margin: "8px 0", paddingLeft: 18 }}>
              <li><small>Checked all {job.scanned} store items.</small></li>
              <li><small>{job.scanned - job.enqueued - job.skipped_verified} already done — skipped, no repeat work.</small></li>
              <li><small>{job.enqueued} sent for image and video analysis — finishes on its own in a few minutes.</small></li>
              <li><small>{job.skipped_verified === 0 ? "Nothing needs your review." : `${job.skipped_verified} need your review below.`}</small></li>
            </ul>
          </>
        ) : (
          <p className="r2ac-err"><small>Scan stopped with an error: {job.error} Try again from the dashboard.</small></p>
        )}
        <p><a className="btn btn-ghost" href={shop ? `/?shop=${encodeURIComponent(shop)}` : "/"}>Back to dashboard</a></p>
        <p><small>Vision quality across all rows: {muse} analyzed in detail, {heur} basic info only{muse + heur === 0 ? " (no rows yet)" : ""}.</small></p>
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
