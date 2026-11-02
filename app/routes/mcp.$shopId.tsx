import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "~/lib/db";
import { textEmbedding, toVectorLiteral } from "~/lib/video/embed";

// PRD §7: MCP at /mcp/{shop_id} — 4 tools, Edge, Neon reads only, no vision.
// search_products | get_product_details | get_inventory | get_video_summary
export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const tool = url.searchParams.get("tool") ?? "search_products";
  const sql = db();

  if (tool === "get_video_summary") {
    const videoId = url.searchParams.get("video_id") ?? "";
    const rows = (await sql`SELECT summary FROM video_cache WHERE video_id = ${videoId} LIMIT 1`) as { summary: unknown }[];
    return json(rows[0] ?? { error: "not found" }, { status: rows.length ? 200 : 404 });
  }

  if (tool === "search_products") {
    const q = url.searchParams.get("query") ?? "";
    // pgvector cosine rerank: query embedding vs stored video vectors.
    // Falls back to JSONB text match when no vectors exist yet.
    if (q) {
      const vec = toVectorLiteral(textEmbedding(q));
      try {
        const ranked = (await sql`
          SELECT id, summary, pdp_url, (embedding <=> ${vec}::vector) AS score
          FROM video_embeddings WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${vec}::vector LIMIT 20`) as unknown[];
        if (ranked.length)
          return json({ shop: params.shopId, tool, q, results: ranked, rerank: "cosine-v1" });
      } catch {
        // vector query failed — fall through to text match
      }
    }
    const rows = (await sql`
      SELECT id, summary, pdp_url FROM video_embeddings
      WHERE summary::text ILIKE ${"%" + q + "%"} LIMIT 20`) as { id: string; summary: unknown; pdp_url: string }[];
    return json({ shop: params.shopId, tool, q, results: rows, rerank: "text-fallback" });
  }

  // get_product_details + get_inventory read Shopify cache in Neon (stub)
  return json({ shop: params.shopId, tool, ok: true });
}
