import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { db } from "~/lib/db";

// Embedded home: pipeline health at a glance. Reads Neon counts only.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "unknown shop";
  let counts = { videos: -1, products: -1 };
  try {
    const sql = db();
    const [v, p] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM video_cache`,
      sql`SELECT COUNT(*)::int AS n FROM video_embeddings`,
    ]);
    counts = {
      videos: (v as { n: number }[])[0]?.n ?? -1,
      products: (p as { n: number }[])[0]?.n ?? -1,
    };
  } catch {
    // DB unreachable — page still renders, counts show as unavailable.
  }
  return json({ shop, counts, modal: process.env.MODAL_WEBHOOK_URL ?? null });
}

const card: React.CSSProperties = {
  border: "1px solid #e5e0d8",
  borderRadius: 12,
  padding: 16,
  background: "#fff",
};

export default function Home() {
  const { shop, counts, modal } = useLoaderData<typeof loader>();
  const ok = (n: number) => (n >= 0 ? String(n) : "unavailable");
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", background: "#faf8f4", minHeight: "100vh" }}>
      <h1 style={{ color: "#0F4C4A" }}>Reel2AICart</h1>
      <p>
        Installed on <strong>{shop}</strong>
      </p>
      <section style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginTop: 16 }}>
        <div style={card}>
          <h3>Video cache</h3>
          <p style={{ fontSize: 28, margin: 0 }}>{ok(counts.videos)}</p>
          <small>summaries served &lt;20ms, no vision</small>
        </div>
        <div style={card}>
          <h3>Video embeddings</h3>
          <p style={{ fontSize: 28, margin: 0 }}>{ok(counts.products)}</p>
          <small>pgvector rows for MCP search</small>
        </div>
        <div style={card}>
          <h3>Enrichment worker</h3>
          <p style={{ margin: 0, color: modal ? "#0F4C4A" : "#FF7A5C" }}>
            {modal ? "connected" : "not configured"}
          </p>
          <small>Modal ingest endpoint</small>
        </div>
      </section>
      <p style={{ marginTop: 16 }}>
        <a href="/connect" style={{ color: "#FF7A5C" }}>Connect Instagram + YouTube →</a>
      </p>
    </main>
  );
}
