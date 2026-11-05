import { db } from "~/lib/db";
import { textEmbedding, toVectorLiteral } from "~/lib/video/embed";

// MCP tool implementations shared by the legacy GET route and the
// JSON-RPC action. Same Neon reads + bge ranker, no vision.
export const TOOLS = [
  {
    name: "search_products",
    description: "Vector-ranked product search over a store's shoppable videos",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Natural-language product query" } },
      required: ["query"],
    },
  },
  {
    name: "get_video_summary",
    description: "Cached video summary JSON, no vision call",
    inputSchema: {
      type: "object",
      properties: { video_id: { type: "string" } },
      required: ["video_id"],
    },
  },
  {
    name: "get_product_details",
    description: "Product details from the Shopify cache (beta stub)",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    },
  },
  {
    name: "get_inventory",
    description: "Real-time inventory for a SKU (beta stub)",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    },
  },
];

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

export async function callTool(
  shop: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const sql = db();
  if (name === "search_products") {
    const q = String(args.query ?? "");
    // Merge BGE + deterministic rankings: the BGE branch used to early-return,
    // shadowing rows that only carry deterministic embeddings. Placeholder
    // summaries (enrichment pending, text_seed is a bare CDN URL) never rank.
    type Hit = { id: string; summary: { text_seed?: string }; pdp_url: string; score: number };
    const seen = new Map<string, Hit>();
    const take = (rows: unknown): boolean => {
      let added = false;
      for (const r of rows as Hit[]) {
        if (!r || seen.has(r.id)) continue;
        if (String(r.summary?.text_seed ?? "").startsWith("http")) continue;
        if (typeof r.score !== "number") r.score = Number.POSITIVE_INFINITY;
        seen.set(r.id, r);
        added = true;
      }
      return added;
    };
    // Text-match boost: rows whose summary literally contains the query rank
    // above pure-vector neighbours. Short queries ("sari") sit in a weak
    // cosine regime where unrelated summaries outrank real matches.
    const like = "%" + q + "%";
    const modes: string[] = [];
    const bge = q ? await bgeQuery(q) : null;
    if (bge) {
      try {
        const ranked = await sql`
          SELECT id, summary, pdp_url, (embedding <=> ${bge}::vector) AS score
          FROM video_embeddings WHERE summary->>'providers' IS NOT NULL
            AND summary->'providers'->>'embed' = 'deepinfra-bge-v1'
          ORDER BY (CASE WHEN summary::text ILIKE ${like} THEN 0 ELSE 1 END), embedding <=> ${bge}::vector LIMIT 20`;
        if (take(ranked)) modes.push("cosine-bge-v1");
      } catch {
        // fall through
      }
    }
    if (q) {
      const vec = toVectorLiteral(textEmbedding(q));
      try {
        const ranked = await sql`
          SELECT id, summary, pdp_url, (embedding <=> ${vec}::vector) AS score
          FROM video_embeddings WHERE embedding IS NOT NULL
          ORDER BY (CASE WHEN summary::text ILIKE ${like} THEN 0 ELSE 1 END), embedding <=> ${vec}::vector LIMIT 20`;
        if (take(ranked)) modes.push("cosine-v1");
      } catch {
        // fall through
      }
    }
    if (seen.size) return { shop, tool: name, q, results: [...seen.values()].slice(0, 20), rerank: modes.join("+") };
    const rows = (await sql`
      SELECT id, summary, pdp_url FROM video_embeddings
      WHERE summary::text ILIKE ${"%" + q + "%"} LIMIT 20`) as unknown[];
    take(rows);
    return { shop, tool: name, q, results: [...seen.values()].slice(0, 20), rerank: "text-fallback" };
  }
  if (name === "get_video_summary") {
    const videoId = String(args.video_id ?? "");
    const rows = (await sql`SELECT summary FROM video_cache WHERE video_id = ${videoId} LIMIT 1`) as {
      summary: unknown;
    }[];
    if (!rows.length) throw new Error("video not found");
    return rows[0];
  }
  if (name === "get_product_details" || name === "get_inventory") {
    return { shop, tool: name, ok: true };
  }
  throw new Error(`unknown tool: ${name}`);
}
