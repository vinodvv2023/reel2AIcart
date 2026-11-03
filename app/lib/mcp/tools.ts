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
    const bge = q ? await bgeQuery(q) : null;
    if (bge) {
      try {
        const ranked = (await sql`
          SELECT id, summary, pdp_url, (embedding <=> ${bge}::vector) AS score
          FROM video_embeddings WHERE summary->>'providers' IS NOT NULL
            AND summary->'providers'->>'embed' = 'deepinfra-bge-v1'
          ORDER BY embedding <=> ${bge}::vector LIMIT 20`) as unknown[];
        if (ranked.length) return { shop, tool: name, q, results: ranked, rerank: "cosine-bge-v1" };
      } catch {
        // fall through
      }
    }
    if (q) {
      const vec = toVectorLiteral(textEmbedding(q));
      try {
        const ranked = (await sql`
          SELECT id, summary, pdp_url, (embedding <=> ${vec}::vector) AS score
          FROM video_embeddings WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${vec}::vector LIMIT 20`) as unknown[];
        if (ranked.length)
          return { shop, tool: name, q, results: ranked, rerank: "cosine-v1" };
      } catch {
        // fall through
      }
    }
    const rows = (await sql`
      SELECT id, summary, pdp_url FROM video_embeddings
      WHERE summary::text ILIKE ${"%" + q + "%"} LIMIT 20`) as unknown[];
    return { shop, tool: name, q, results: rows, rerank: "text-fallback" };
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
