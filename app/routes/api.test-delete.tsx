import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { db } from "~/lib/db";

// Demo helper: deletes ONE non-verified embedding (+ its cache row) so a
// tester can click "Scan existing catalog" and watch the product get
// re-enriched end to end. Browser-gated via cookie: 2 resets max, the 3rd
// attempt is refused with ?test=limit. Soft gate (clearing cookies resets
// it) — for test stores, not a security boundary. Verified rows are never
// touched, so merchant-approved copies stay frozen.
const COOKIE = "r2ac_test_deletes";
const MAX_TESTS = 2;

function testCount(header: string | null): number {
  const m = /(?:^|;\s*)r2ac_test_deletes=(\d+)/.exec(header ?? "");
  const n = m ? parseInt(m[1], 10) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 99) : 0;
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const shop = String(form.get("shop") ?? "");
  if (!shop) return redirect("/");
  const back = `/?shop=${encodeURIComponent(shop)}`;
  if (testCount(request.headers.get("Cookie")) >= MAX_TESTS) {
    return redirect(`${back}&test=limit`);
  }
  try {
    const sql = db();
    const like = `https://${shop}/%`;
    let rows = (await sql`SELECT id, video_hash, summary->>'product_id' AS pid
      FROM video_embeddings
      WHERE NOT verified AND pdp_url LIKE ${like}
      ORDER BY created_at DESC LIMIT 1`) as { id: string; video_hash: string; pid: string | null }[];
    if (!rows.length) {
      rows = (await sql`SELECT id, video_hash, summary->>'product_id' AS pid
        FROM video_embeddings
        WHERE NOT verified
        ORDER BY created_at DESC LIMIT 1`) as typeof rows;
    }
    if (!rows.length) return redirect(`${back}&test=empty`);
    const [row] = rows;
    await sql`DELETE FROM video_embeddings WHERE id = ${row.id}`;
    try {
      await sql`DELETE FROM video_cache WHERE video_id = ${row.video_hash}`;
    } catch {
      // cache is best-effort; embeddings delete is the source of truth
    }
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      `${COOKIE}=${testCount(request.headers.get("Cookie")) + 1}; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    return redirect(
      `${back}&test=deleted:${encodeURIComponent(row.pid ?? row.video_hash.slice(0, 12))}`,
      { headers },
    );
  } catch {
    return redirect(`${back}&test=error`);
  }
}
