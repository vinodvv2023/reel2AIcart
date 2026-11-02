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
    // Query embedding must use the SAME algorithm as the stored rows.
    // bge (current rows) first, hash (legacy rows) second, text match last.
    if (q) {
      const bge = await bgeQuery(q);
      if (bge) {
        try {
          const ranked = (await sql`
            SELECT id, summary, pdp_url, (embedding <=> ${bge}::vector) AS score
            FROM video_embeddings WHERE summary->>'providers' IS NOT NULL
              AND summary->'providers'->>'embed' = 'deepinfra-bge-v1'
            ORDER BY embedding <=> ${bge}::vector LIMIT 20`) as unknown[];
          if (ranked.length)
            return json({ shop: params.shopId, tool, q, results: ranked, rerank: "cosine-bge-v1" });
        } catch {
          // vector query failed — fall through
        }
      }
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

  // bge query vector via DeepInfra (server-side; matches deepinfra-bge-v1 rows).
// Null when DEEPINFRA_TOKEN is unset or the call fails — caller falls back.
async function bgeQuery(text: string): Promise<string | null> {
  const token = process.env.DEEPINFRA_TOKEN ?? "";
  if (!token) return null;
  try {
    const res = await fetch("https://api.deepinfra.com/v1/openai/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "BAAI/bge-large-en-v1.5", input: text }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return toVectorLiteral(j.data[0].embedding);
  } catch {
    return null;
  }
}

// get_product_details + get_inventory read Shopify cache in Neon (stub)
  return json({ shop: params.shopId, tool, ok: true });
}
