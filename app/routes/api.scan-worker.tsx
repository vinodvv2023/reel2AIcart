import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";

// Cron worker: one Admin page (250 products) per tick, ~2 req/s safe.
// New products only (exists → dupe-skip, verified → held); refresh of
// existing unverified rows stays on the re-save path. Same CRON_SECRET
// auth as the attribution cron.
type Job = {
  id: number;
  shop: string;
  cursor: string;
  scanned: number;
  enqueued: number;
  skipped_verified: number;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return json({ error: "unauthorized" }, { status: 401 });
  const sql = db();
  const jobs = (await sql`SELECT id, shop, cursor, scanned, enqueued, skipped_verified
    FROM scan_jobs WHERE status IN ('queued','running') ORDER BY id LIMIT 1`) as Job[];
  if (!jobs.length) return json({ ok: true, idle: true });
  const job = jobs[0];
  await sql`UPDATE scan_jobs SET status = 'running', updated_at = NOW() WHERE id = ${job.id}`;
  try {
    const shops = (await sql`SELECT access_token FROM shops WHERE shop = ${job.shop} LIMIT 1`) as {
      access_token: string;
    }[];
    if (!shops.length) throw new Error("shop token gone");
    const base =
      `https://${job.shop}/admin/api/2026-10/products.json?limit=250&fields=id,images` +
      (job.cursor ? `&page_info=${encodeURIComponent(job.cursor)}` : "");
    const res = await fetch(base, { headers: { "X-Shopify-Access-Token": shops[0].access_token } });
    if (!res.ok) throw new Error(`shopify ${res.status}`);
    const { products } = (await res.json()) as {
      products: { id: number; images?: { src?: string }[] }[];
    };
    const next = /page_info=([^>&]+)[^>]*>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? "";
    const origin = new URL(request.url).origin;
    let enqueued = 0,
      held = 0,
      failed = 0;
    for (const p of products) {
      const seen = (await sql`SELECT verified FROM video_embeddings
        WHERE summary->>'product_id' = ${String(p.id)} LIMIT 1`) as { verified: boolean }[];
      if (seen.length) {
        if (seen[0].verified) held++;
        continue;
      }
      const jobKey = `${job.shop}:${p.id}:scan:${job.id}:${Date.now()}`;
      try {
        await sql`INSERT INTO ingest_jobs (job_key, shop, product_id, source)
          VALUES (${jobKey}, ${job.shop}, ${p.id}, 'scan')
          ON CONFLICT (job_key) DO NOTHING`;
      } catch {
        // tracking never blocks the forward
      }
      const hero = [...(p.images ?? []).map((i) => i.src).filter(Boolean)].slice(0, 3);
      try {
        const fwd = await fetch(process.env.MODAL_WEBHOOK_URL ?? "", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shop: job.shop, topic: "scan", product_id: p.id, video_url: "",
            hero_images: hero, secret: process.env.MODAL_INGEST_SECRET ?? "",
            job_key: jobKey,
            callback_url: `${origin}/api/ingest-callback`,
            callback_secret: process.env.MODAL_INGEST_SECRET ?? "",
          }),
        });
        await sql`UPDATE ingest_jobs SET status = ${fwd.ok ? "sent" : "failed"},
          detail = ${`modal ${fwd.status}`}, updated_at = NOW() WHERE job_key = ${jobKey}`;
        if (fwd.ok) enqueued++;
        else failed++;
      } catch (e) {
        failed++;
        try {
          await sql`UPDATE ingest_jobs SET status = 'failed',
            detail = ${String(e).slice(0, 200)}, updated_at = NOW() WHERE job_key = ${jobKey}`;
        } catch {
          // tracking never blocks the scan
        }
      }
    }
    await sql`UPDATE scan_jobs SET status = ${next ? "running" : "done"},
      cursor = ${next}, scanned = scanned + ${products.length},
      enqueued = enqueued + ${enqueued}, skipped_verified = skipped_verified + ${held},
      error = ${failed ? `${failed} modal forward(s) failed - see enrichment outcomes` : ""},
      updated_at = NOW() WHERE id = ${job.id}`;
    return json({ ok: true, job: job.id, scanned: products.length, enqueued, held, failed, done: !next });
  } catch (e) {
    await sql`UPDATE scan_jobs SET status = 'failed', error = ${String(e).slice(0, 300)},
      updated_at = NOW() WHERE id = ${job.id}`;
    return json({ ok: false, error: String(e).slice(0, 200) });
  }
}
