import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { db } from "~/lib/db";

type ScanJob = { id: number; shop: string; status: string; scanned: number; enqueued: number; skipped_verified: number; error: string };
type Ready = { shop: string; token_ok: boolean; missing_scopes: string; mcp: string; rows: number; checked_at: string; checks: number };
type Ingest = { job_key: string; shop: string; product_id: number | null; source: string; status: string; detail: string; created_at: string };

// Embedded home: pipeline health at a glance. Reads Neon counts only.
// Styled by the shared r2ac classes in app/tokens.css (same as /connect).
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "unknown shop";
  const recheck = {
    ok: url.searchParams.get("recheck_ok") ?? "",
    msg: url.searchParams.get("recheck_msg") ?? "",
  };
  let counts = { videos: -1, products: -1 };
  let events: { topic: string; status: string; detail: string; created_at: string }[] = [];
  let installed: { shop: string; scopes: string }[] = [];
  let job: ScanJob | null = null;
  let readiness: Ready[] = [];
  let ingest: Ingest[] = [];
  try {
    const sql = db();
    const [v, p, e, s, j, r, n] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM video_cache`,
      sql`SELECT COUNT(*)::int AS n FROM video_embeddings`,
      sql`SELECT topic, status, detail, created_at::text AS created_at FROM webhook_events ORDER BY id DESC LIMIT 10`,
      sql`SELECT shop, scopes FROM shops ORDER BY installed_at DESC`,
      sql`SELECT id, shop, status, scanned, enqueued, skipped_verified, error FROM scan_jobs ORDER BY id DESC LIMIT 1`,
      sql`SELECT DISTINCT ON (c.shop) c.shop, c.token_ok, c.missing_scopes, c.mcp, c.rows,
        c.checked_at::text AS checked_at, (SELECT COUNT(*)::int FROM shop_status_checks h WHERE h.shop = c.shop) AS checks
        FROM shop_status_checks c ORDER BY c.shop, c.checked_at DESC`,
      sql`SELECT job_key, shop, product_id, source, status, detail, created_at::text AS created_at FROM ingest_jobs ORDER BY id DESC LIMIT 10`,
    ]);
    counts = {
      videos: (v as { n: number }[])[0]?.n ?? -1,
      products: (p as { n: number }[])[0]?.n ?? -1,
    };
    events = e as typeof events;
    installed = s as typeof installed;
    job = ((j as ScanJob[])[0] ?? null);
    readiness = r as typeof readiness;
    ingest = n as typeof ingest;
  } catch {
    // DB unreachable — page still renders, counts show as unavailable.
  }
  return json({ shop, counts, modal: process.env.MODAL_WEBHOOK_URL ?? null, events, installed, job, readiness, recheck, ingest });
}

export default function Home() {
  const { shop, counts, modal, events, installed, job, readiness, recheck, ingest } = useLoaderData<typeof loader>();
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
      <p>
        <small>Test storefront is password-gated — password: <code>ChangeMe!</code></small>{" "}
        {scanShop && (
          <a className="btn btn-ghost" href={`https://${scanShop}`} target="_blank" rel="noreferrer">View storefront</a>
        )}
      </p>
      <section className="r2ac-card" style={{ marginTop: 12 }}>
        <h3>Catalog scan</h3>
        {(() => {
          const open = job && (job.status === "queued" || job.status === "running");
          return (
            <>
              {job && open ? (
                <p><small>Scan in progress — {job.scanned} checked, {job.enqueued} being analyzed.</small></p>
              ) : job && job.status === "done" ? (
                <p className="r2ac-ok"><small>Scan complete — {job.scanned} checked, {job.enqueued} analyzed{job.skipped_verified > 0 ? `, ${job.skipped_verified} need review` : ""}.</small></p>
              ) : job && job.status === "failed" ? (
                <p className="r2ac-err"><small>Scan stopped: {job.error}</small></p>
              ) : (
                <p><small>Backfill enrichment without manual re-saves. Verified rows are never touched.</small></p>
              )}
              <p>
                {scanShop && !open ? (
                  <Form method="post" action="/api/scan" style={{ display: "inline" }}>
                    <input type="hidden" name="shop" value={scanShop} />
                    <button type="submit" className="btn btn-primary">Scan existing catalog</button>
                  </Form>
                ) : scanShop ? (
                  <button type="button" className="btn btn-primary" disabled>Scan in progress</button>
                ) : (
                  <small>No installed shop to scan.</small>
                )}{" "}
                {scanShop && (
                  <a className="btn btn-ghost" href={`/scan?shop=${encodeURIComponent(scanShop)}`}>Watch progress</a>
                )}
              </p>
            </>
          );
        })()}
      </section>
      <section className="r2ac-card" style={{ marginTop: 12 }}>
        <h3>Store readiness (webMCP)</h3>
        {recheck.msg && (
          <p role="status" className={recheck.ok === "1" ? "r2ac-ok" : "r2ac-err"}>
            <small>{recheck.msg}</small>
          </p>
        )}
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
                  <button type="submit" className="btn btn-ghost">Re-check</button>
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
      <section className="r2ac-card" style={{ marginTop: 12 }}>
        <h3>Enrichment outcomes</h3>
        {ingest.length === 0 ? (
          <small>No payloads sent yet - save a product or run a scan.</small>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {ingest.map((n) => (
              <li key={n.job_key}>
                <code>{n.source}:{String(n.product_id)}</code> -{" "}
                <strong className={n.status === "enriched" ? "r2ac-ok" : n.status === "failed" ? "r2ac-err" : ""}>
                  {n.status === "sent" ? "sent - outcome pending" : n.status}
                </strong>{" "}
                <small>
                  {n.detail} · {n.created_at}
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
          {known && <input type="hidden" name="shop" value={shop} />}
          <label htmlFor="fabq"><strong>Search</strong></label><br />
          <input id="fabq" name="q" type="search" required placeholder="e.g. ballerina" />{" "}
          <button type="submit" className="btn btn-primary">Go</button>
        </Form>
        <p style={{ marginBottom: 0 }}>
          <small>
            <a href={known ? `/agent?shop=${encodeURIComponent(shop)}` : "/agent"}>Open full chat</a> ·{" "}
            <label htmlFor="r2ac-agent-toggle" style={{ cursor: "pointer", textDecoration: "underline" }}>Close</label>
          </small>
        </p>
      </div>
    </main>
  );
}
