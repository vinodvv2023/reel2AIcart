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
    let enqueued = 0,
      held = 0;
    for (const p of products) {
      const seen = (await sql`SELECT verified FROM video_embeddings
        WHERE summary->>'product_id' = ${String(p.id)} LIMIT 1`) as { verified: boolean }[];
      if (seen.length) {
        if (seen[0].verified) held++;
        continue;
      }
      const hero = [...(p.images ?? []).map((i) => i.src).filter(Boolean)].slice(0, 3);
      await fetch(process.env.MODAL_WEBHOOK_URL ?? "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: job.shop, topic: "scan", product_id: p.id, video_url: "",
          hero_images: hero, secret: process.env.MODAL_INGEST_SECRET ?? "",
        }),
      }).catch(() => null);
      enqueued++;
    }
    await sql`UPDATE scan_jobs SET status = ${next ? "running" : "done"},
      cursor = ${next}, scanned = scanned + ${products.length},
      enqueued = enqueued + ${enqueued}, skipped_verified = skipped_verified + ${held},
      updated_at = NOW() WHERE id = ${job.id}`;
    return json({ ok: true, job: job.id, scanned: products.length, enqueued, held, done: !next });
  } catch (e) {
    await sql`UPDATE scan_jobs SET status = 'failed', error = ${String(e).slice(0, 300)},
      updated_at = NOW() WHERE id = ${job.id}`;
    return json({ ok: false, error: String(e).slice(0, 200) });
  }
}
