import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { db } from "~/lib/db";

type ScanJob = { id: number; shop: string; status: string; scanned: number; enqueued: number; skipped_verified: number; error: string };
type Ready = { shop: string; token_ok: boolean; missing_scopes: string; mcp: string; rows: number; checked_at: string; checks: number };

// Embedded home: pipeline health at a glance. Reads Neon counts only.
// Styled by the shared r2ac classes in app/tokens.css (same as /connect).
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "unknown shop";
  let counts = { videos: -1, products: -1 };
  let events: { topic: string; status: string; detail: string; created_at: string }[] = [];
  let installed: { shop: string; scopes: string }[] = [];
  let job: ScanJob | null = null;
  let frozen: { video_hash: string; url: string; vision: string }[] = [];
  let readiness: Ready[] = [];
  try {
    const sql = db();
    const [v, p, e, s, j, f, r] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM video_cache`,
      sql`SELECT COUNT(*)::int AS n FROM video_embeddings`,
      sql`SELECT topic, status, detail, created_at::text AS created_at FROM webhook_events ORDER BY id DESC LIMIT 10`,
      sql`SELECT shop, scopes FROM shops ORDER BY installed_at DESC`,
      sql`SELECT id, shop, status, scanned, enqueued, skipped_verified, error FROM scan_jobs ORDER BY id DESC LIMIT 1`,
      sql`SELECT video_hash, summary->>'video_url' AS url, summary->'providers'->>'vision' AS vision FROM video_embeddings WHERE verified ORDER BY video_hash LIMIT 50`,
      sql`SELECT DISTINCT ON (c.shop) c.shop, c.token_ok, c.missing_scopes, c.mcp, c.rows,
        c.checked_at::text AS checked_at, (SELECT COUNT(*)::int FROM shop_status_checks h WHERE h.shop = c.shop) AS checks
        FROM shop_status_checks c ORDER BY c.shop, c.checked_at DESC`,
    ]);
    counts = {
      videos: (v as { n: number }[])[0]?.n ?? -1,
      products: (p as { n: number }[])[0]?.n ?? -1,
    };
    events = e as typeof events;
    installed = s as typeof installed;
    job = ((j as ScanJob[])[0] ?? null);
    frozen = f as typeof frozen;
    readiness = r as typeof readiness;
  } catch {
    // DB unreachable — page still renders, counts show as unavailable.
  }
  return json({ shop, counts, modal: process.env.MODAL_WEBHOOK_URL ?? null, events, installed, job, frozen, readiness });
}

export default function Home() {
  const { shop, counts, modal, events, installed, job, frozen, readiness } = useLoaderData<typeof loader>();
  const ok = (n: number) => (n >= 0 ? String(n) : "unavailable");
  const known = shop !== "unknown shop";
  const scanShop = known ? shop : installed[0]?.shop ?? "";
  return (
    <main className="r2ac-wrap">
      <header className="r2ac-brand" aria-label="Reel2AICart">
        <span className="r2ac-mark" aria-hidden="true" />
        <strong style={{ fontSize: 22, color: "#0f4c4a" }}>
          Reel2<span style={{ color: "#ff7a5c" }}>AI</span>Cart
        </strong>
      </header>
      <section className="r2ac-card" style={{ marginTop: 16 }}>
        <h2>Pipeline health</h2>
        <p>
          Installed on <strong>{shop}</strong>
          {!known && (
            <small> (opened directly - Shopify passes ?shop= inside admin; tenants below come from the installs table)</small>
          )}
        </p>
        {!known && installed.length > 0 && (
          <p>
            <small>
              Installed tenants:{" "}
              {installed.map((s) => (
                <span key={s.shop}>
                  <a href={`/?shop=${encodeURIComponent(s.shop)}`}>{s.shop}</a> ({s.scopes || "no scopes recorded"}){" "}
                </span>
              ))}
            </small>
          </p>
        )}
      </section>
      <section className="r2ac-stats">
        <div className="r2ac-card">
          <h3>Video cache</h3>
          <p className="r2ac-num">{ok(counts.videos)}</p>
          <small>summaries served &lt;20ms, no vision</small>
        </div>
        <div className="r2ac-card">
          <h3>Video embeddings</h3>
          <p className="r2ac-num">{ok(counts.products)}</p>
          <small>pgvector rows for MCP search</small>
        </div>
        <div className="r2ac-card">
          <h3>Enrichment worker</h3>
          <p className={modal ? "r2ac-ok" : "r2ac-err"} style={{ margin: 0 }}>
            {modal ? "connected" : "not configured"}
          </p>
          <small>Modal ingest endpoint</small>
        </div>
      </section>
      <p style={{ marginTop: 16 }}>
        <a className="btn btn-ghost" href="/connect">Connect Instagram</a>{" "}
        {known ? (
          <a className="btn btn-ghost" href={`/auth/login?shop=${encodeURIComponent(shop)}`} target="_top">Reconnect store</a>
        ) : (
          <small>Open this page from Apps in your store admin to enable reconnect.</small>
        )}
      </p>
      <section className="r2ac-card" style={{ marginTop: 12 }}>
        <h3>Catalog scan</h3>
        {job && (job.status === "queued" || job.status === "running") ? (
          <p><small>Job #{job.id} {job.status} — {job.scanned} scanned, {job.enqueued} enqueued, {job.skipped_verified} held.</small></p>
        ) : job && job.status === "done" ? (
          <p className="r2ac-ok"><small>Job #{job.id} complete — {job.scanned} scanned, {job.enqueued} enqueued, {job.skipped_verified} held for review.</small></p>
        ) : job && job.status === "failed" ? (
          <p className="r2ac-err"><small>Job #{job.id} failed: {job.error}</small></p>
        ) : (
          <p><small>No scans yet.</small></p>
        )}
        {scanShop ? (
          <Form method="post" action="/api/scan">
            <input type="hidden" name="shop" value={scanShop} />
            <button type="submit" className="btn btn-primary">Scan existing catalog</button>
          </Form>
        ) : (
          <small>No installed shop to scan.</small>
        )}
      </section>
      {frozen.length > 0 && (
        <section className="r2ac-card" style={{ marginTop: 12 }}>
          <h3>Verified rows (frozen)</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {frozen.map((r) => (
              <li key={r.video_hash}>
                <small><code>{r.video_hash.slice(0, 12)}…</code> {r.url} ({r.vision})</small>{" "}
                <Form method="post" action="/api/release" style={{ display: "inline" }}>
                  <input type="hidden" name="shop" value={scanShop} />
                  <input type="hidden" name="video_hash" value={r.video_hash} />
                  <button type="submit">Release</button>
                </Form>
              </li>
            ))}
          </ul>
          <Form method="post" action="/api/release" style={{ marginTop: 8 }}>
            <input type="hidden" name="shop" value={scanShop} />
            <input type="hidden" name="all" value="1" />
            <button type="submit">Release all</button>
          </Form>
        </section>
      )}
      <section className="r2ac-card" style={{ marginTop: 12 }}>
        <h3>Store readiness (webMCP)</h3>
        {readiness.length === 0 ? (
          <p><small>No checks yet - install or re-authorize a store, or Re-check below.</small></p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {readiness.map((c) => (
              <li key={c.shop}>
                <small>
                  <strong>{c.shop}</strong> - token{" "}
                  <strong className={c.token_ok ? "r2ac-ok" : "r2ac-err"}>{c.token_ok ? "ok" : "dead"}</strong>
                  {c.missing_scopes ? ` - missing: ${c.missing_scopes}` : " - scopes ok"} - MCP{" "}
                  <strong className={c.mcp === "ready" ? "r2ac-ok" : "r2ac-err"}>{c.mcp}</strong>
                  {" "}({c.rows} rows, {c.checks} checks, {c.checked_at})
                </small>{" "}
                <Form method="post" action="/api/activate" style={{ display: "inline" }}>
                  <input type="hidden" name="shop" value={c.shop} />
                  <button type="submit">Re-check</button>
                </Form>
              </li>
            ))}
          </ul>
        )}
        <p><small>Webhooks: declared at deploy (products/create, products/update, inventory_levels/update). Agent entry: <a href="/openapi.yaml">openapi.yaml</a>.</small></p>
      </section>
      <section className="r2ac-card" style={{ marginTop: 12 }}>
        <h3>Recent webhook deliveries</h3>
        {events.length === 0 ? (
          <small>No deliveries recorded yet - save a product to fire one.</small>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {events.map((ev, i) => (
              <li key={i}>
                <code>{ev.topic}</code> -{" "}
                <strong className={ev.status === "forwarded" ? "r2ac-ok" : "r2ac-err"}>
                  {ev.status}
                </strong>{" "}
                <small>
                  {ev.detail} · {ev.created_at}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <input type="checkbox" id="r2ac-agent-toggle" style={{ display: "none" }} />
      <label htmlFor="r2ac-agent-toggle" className="r2ac-fab">Search with your fav agent</label>
      <div className="r2ac-agent-panel" role="dialog" aria-label="Use agent to search products">
        <h3>Use agent to search products</h3>
        <p><small>Vector search over your shoppable videos, answered with PDP links.</small></p>
        <Form method="get" action="/agent" aria-label="Quick product search">
          <input type="hidden" name="tab" value="search" />
          <label htmlFor="fabq"><strong>Search</strong></label><br />
          <input id="fabq" name="q" type="search" required placeholder="e.g. ballerina" />{" "}
          <button type="submit" className="btn btn-primary">Go</button>
        </Form>
        <p style={{ marginBottom: 0 }}>
          <small>
            <a href="/agent">Open full chat</a> ·{" "}
            <label htmlFor="r2ac-agent-toggle" style={{ cursor: "pointer", textDecoration: "underline" }}>Close</label>
          </small>
        </p>
      </div>
    </main>
  );
}
