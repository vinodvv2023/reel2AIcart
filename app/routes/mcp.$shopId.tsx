import type { LoaderFunctionArgs } from "@remix-run/node";
import { db } from "~/lib/db";

// PRD §7: MCP at /mcp/{shop_id} — 4 tools, Edge, Neon reads only, no vision.
// search_products | get_product_details | get_inventory | get_video_summary
export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const tool = url.searchParams.get("tool") ?? "search_products";
  const sql = db();

  if (tool === "get_video_summary") {
    const videoId = url.searchParams.get("video_id") ?? "";
    const rows = (await sql`SELECT summary FROM video_cache WHERE video_id = ${videoId} LIMIT 1`) as { summary: unknown }[];
    return Response.json(rows[0] ?? { error: "not found" }, { status: rows.length ? 200 : 404 });
  }

  if (tool === "search_products") {
    const q = url.searchParams.get("query") ?? "";
    // pgvector cosine search: summary JSONB text match first, embedding rerank TODO Day 9-10
    const rows = (await sql`
      SELECT id, summary, pdp_url FROM video_embeddings
      WHERE summary::text ILIKE ${"%" + q + "%"} LIMIT 20`) as { id: string; summary: unknown; pdp_url: string }[];
    return Response.json({ shop: params.shopId, tool, q, results: rows });
  }

  // get_product_details + get_inventory read Shopify cache in Neon (stub)
  return Response.json({ shop: params.shopId, tool, ok: true });
}
