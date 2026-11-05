import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { tagInstagram } from "~/lib/activation/instagram";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";
import { db } from "~/lib/db";
import { generateImage, type GenerateFailure, type GenerateSuccess, type ImageErrorCode, type ImageStyle } from "~/lib/image/generate";

// Tag-a-reel workspace: reels left, products right, review table above Tag.
// All selection is URL state (?reel ?product ?variant) so the review table
// always mirrors the picks — no floating disconnected choices. Server state
// only, no client JS.
type Reel = { id: string; caption?: string; thumbnail_url?: string; media_url?: string; media_type?: string; timestamp?: string };
type Variant = { id: number; title: string; price: string };
type Product = { id: number; title: string; image?: string; variants: Variant[] };
const PER_PAGE = 8;
const STYLES = ["flat-lay", "folded-stack", "single-folded", "ghost-mannequin", "hanger", "on-actor"] as const;
const isGenStyle = (s: string): s is ImageStyle => (STYLES as readonly string[]).includes(s);

async function igMedia(): Promise<{ reels: Reel[]; error: string | null }> {
  const token = process.env.META_GRAPH_TOKEN ?? "";
  const ig = process.env.IG_USER_ID ?? "";
  if (!token || !ig) return { reels: [], error: "IG keys missing in Vercel env." };
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${ig}/media?fields=id,caption,thumbnail_url,media_url,media_type,timestamp&limit=25&access_token=${token}`,
    );
    if (!r.ok) return { reels: [], error: `IG API ${r.status} - token may be expired.` };
    return { reels: ((await r.json()) as { data: Reel[] }).data ?? [], error: null };
  } catch {
    return { reels: [], error: "IG API unreachable." };
  }
}

async function shopProducts(): Promise<{ products: Product[]; error: string | null }> {
  try {
    const sql = db();
    const shops = (await sql`SELECT shop, access_token FROM shops LIMIT 1`) as {
      shop: string;
      access_token: string;
    }[];
    if (!shops.length) return { products: [], error: "No shop installed yet." };
    const r = await fetch(
      `https://${shops[0].shop}/admin/api/2026-10/products.json?limit=50&fields=id,title,image,variants`,
      { headers: { "X-Shopify-Access-Token": shops[0].access_token } },
    );
    if (!r.ok) return { products: [], error: `Shopify API ${r.status} - re-authorize the store.` };
    const { products } = (await r.json()) as {
      products: (Omit<Product, "image"> & { image?: { src?: string } | null })[];
    };
    return { products: products.map((p) => ({ ...p, image: p.image?.src })), error: null };
  } catch {
    return { products: [], error: "Shopify API unreachable." };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const rq = params.get("rq") ?? "";
  const productId = params.get("product") ?? "";
  const variantId = params.get("variant") ?? "";
  const reelId = params.get("reel") ?? "";
  const rawStyle = params.get("style") ?? "";
  const genStyle = isGenStyle(rawStyle) ? rawStyle : "";
  const pg = Math.max(1, parseInt(params.get("pg") ?? "1", 10) || 1);
  const rpg = Math.max(1, parseInt(params.get("rpg") ?? "1", 10) || 1);
  const [{ reels, error: reelsError }, { products, error: productsError }] = await Promise.all([
    igMedia(),
    shopProducts(),
  ]);
  const matchedReels = rq
    ? reels.filter(
        (r) => (r.caption ?? "").toLowerCase().includes(rq.toLowerCase()) || r.id.includes(rq),
      )
    : reels;
  const rPages = Math.max(1, Math.ceil(matchedReels.length / PER_PAGE));
  const rPage = Math.min(rpg, rPages);
  const matched = q
    ? products.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()))
    : products;
  const pages = Math.max(1, Math.ceil(matched.length / PER_PAGE));
  const page = Math.min(pg, pages);
  const selProduct = products.find((p) => String(p.id) === productId) ?? null;
  const effVariant =
    variantId || (selProduct && selProduct.variants.length === 1 ? String(selProduct.variants[0].id) : "");
  const selVariant = selProduct?.variants.find((v) => String(v.id) === effVariant) ?? null;
  const selReel = reels.find((r) => r.id === reelId) ?? null;
  let taggedHere: Record<string, { variant: string; when: string; status: string }> = {};
  try {
    const sql = db();
    const rows = (await sql`SELECT DISTINCT ON (media_id) media_id,
      variant_id, status, created_at::text AS created_at FROM tag_events
      ORDER BY media_id, created_at DESC`) as {
      media_id: string;
      variant_id: string;
      status: string;
      created_at: string;
    }[];
    for (const r of rows) {
      taggedHere[r.media_id] = { variant: r.variant_id, when: r.created_at.slice(0, 10), status: r.status };
    }
  } catch {
    // history is additive; page works without it
  }
  type GenHistory = { id: number; style: string; sourceMode: string; outputUrl: string; when: string };
  let genHistory: GenHistory[] = [];
  if (productId) {
    try {
      const sql = db();
      const rows = (await sql`SELECT id, style, source_mode, output_url, created_at::text AS created_at
        FROM generated_images WHERE product_id = ${productId}
        ORDER BY created_at DESC LIMIT 12`) as {
        id: number; style: string; source_mode: string; output_url: string; created_at: string;
      }[];
      genHistory = rows.map((r) => ({
        id: r.id, style: r.style, sourceMode: r.source_mode, outputUrl: r.output_url,
        when: r.created_at.slice(0, 16).replace("T", " "),
      }));
    } catch {
      // history is additive; page works without it
    }
  }
  return json({
    hint: humanizeCommerceError("{{IE_30010}}"),
    ig: Boolean(process.env.META_GRAPH_TOKEN && process.env.IG_USER_ID),
    reels: matchedReels.slice((rPage - 1) * PER_PAGE, rPage * PER_PAGE),
    reelsError,
    rTotal: matchedReels.length,
    rPage,
    rPages,
    products: matched.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    productsError,
    total: matched.length,
    page,
    pages,
    q,
    rq,
    productId,
    variantId: effVariant,
    reelId,
    genStyle,
    selReel,
    selProduct,
    selVariant,
    taggedHere,
    genHistory,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "tag");
  if (intent === "generate") return generateAction(form);
  if (intent === "keep") return keepAction(form);
  const mediaId = String(form.get("mediaId") ?? "").trim();
  const variantId = String(form.get("variantId") ?? "").trim();
  if (!mediaId || !variantId)
    return json({ intent: "tag" as const, ok: false as const, error: "Pick a reel, product and variant above." }, { status: 400 });
  const token = process.env.META_GRAPH_TOKEN ?? "";
  if (!token)
    return json({ intent: "tag" as const, ok: false as const, error: "META_GRAPH_TOKEN missing in Vercel env." }, { status: 500 });
  try {
    await tagInstagram(mediaId, variantId, token);
    await logTag(mediaId, variantId, "ok", "");
    return json({ intent: "tag" as const, ok: true as const, mediaId });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Tagging failed.";
    await logTag(mediaId, variantId, "failed", error);
    return json({ intent: "tag" as const, ok: false as const, error });
  }
}

// T6 failure contract (refs #7): every ImageErrorCode maps to an HTTP status.
// The inline merchant message comes from generateImage (T2) verbatim; every
// path below returns json and never redirects, so reel/product/variant picks
// stay intact via URL state.
function genErrorStatus(code: ImageErrorCode): number {
  if (code === "no-keys") return 500;
  if (code === "rate-limit") return 429;
  return 502;
}
function toGenResponse(res: GenerateSuccess | GenerateFailure) {
  if (!res.ok)
    return json({ intent: "generate" as const, ok: false as const, error: res.error.message }, { status: genErrorStatus(res.error.code) });
  return json({ intent: "generate" as const, ok: true as const, outputUrl: res.outputUrl, sourceMode: res.sourceMode });
}
async function logGeneration(e: { shop: string; productId: string; variantId: string; style: string; outcome: "ok" | "failed"; cause: string }) {
  try {
    // Additive event log (shop, product, style, outcome, truncated cause);
    // the durable audit row is the generated_images insert on success.
    console.info(JSON.stringify({ event: "image-generation", ...e, cause: e.cause.slice(0, 300) }));
  } catch {
    // logging never breaks the generation response (logTag convention)
  }
}
// In-flight generations by shop+product+variant+style for click coalescing.
const inflightGen = new Map<string, Promise<GenerateSuccess | GenerateFailure>>();

async function generateAction(form: FormData) {
  const productId = String(form.get("productId") ?? "").trim();
  const variantId = String(form.get("variantId") ?? "").trim();
  const style = String(form.get("style") ?? "").trim();
  if (!productId)
    return json({ intent: "generate" as const, ok: false as const, error: "Pick a product above first, then choose a style and generate." }, { status: 400 });
  if (!isGenStyle(style))
    return json({ intent: "generate" as const, ok: false as const, error: "Pick one of the 6 styles above, then generate." }, { status: 400 });
  const title = String(form.get("productTitle") ?? "").trim() || `Product ${productId}`;
  const variantTitle = String(form.get("variantTitle") ?? "").trim();
  const referenceImageUrl = String(form.get("referenceImageUrl") ?? "").trim();
  let shop = "";
  try {
    const sql = db();
    const shops = (await sql`SELECT shop FROM shops LIMIT 1`) as { shop: string }[];
    shop = shops[0]?.shop ?? "";
  } catch {
    // shop label is best-effort; generation still proceeds
  }
  // One generation per explicit click: identical rapid POSTs (same
  // shop+product+variant+style) share a single provider call. The submit
  // button is also disabled while nav.state !== "idle" (server-state pattern,
  // no client JS). No auto-generate on select, no polling loops.
  const dedupeKey = [shop, productId, variantId, style].join("|");
  const shared = inflightGen.get(dedupeKey);
  if (shared) return toGenResponse(await shared);
  const run = generateImage({
    shop, productId, variantId, title, variantTitle, referenceImageUrl, style,
  });
  inflightGen.set(dedupeKey, run);
  try {
    const res = await run;
    await logGeneration({ shop, productId, variantId, style,
      outcome: res.ok ? "ok" : "failed",
      cause: res.ok ? "sourceMode=" + res.sourceMode : res.error.code + ": " + res.error.message });
    return toGenResponse(res);
  } finally {
    inflightGen.delete(dedupeKey);
  }
}

// T4 (refs #6): keep persists the preview; discard is a plain GET reload so it
// writes nothing. Double-submit guard: existence check before insert — exactly
// one record per accept. Never throws to UI (additive convention).
async function keepAction(form: FormData) {
  const productId = String(form.get("productId") ?? "").trim();
  const variantId = String(form.get("variantId") ?? "").trim();
  const style = String(form.get("style") ?? "").trim();
  const outputUrl = String(form.get("outputUrl") ?? "").trim();
  const sourceMode = String(form.get("sourceMode") ?? "").trim();
  if (!productId || !isGenStyle(style) || !outputUrl)
    return json({ intent: "keep" as const, ok: false as const, error: "Nothing to keep — generate an image first." }, { status: 400 });
  if (outputUrl.length > 4000 || (sourceMode !== "with-image" && sourceMode !== "text-only"))
    return json({ intent: "keep" as const, ok: false as const, error: "Kept image looks invalid — regenerate instead." }, { status: 400 });
  try {
    const sql = db();
    const shops = (await sql`SELECT shop FROM shops LIMIT 1`) as { shop: string }[];
    const shop = shops[0]?.shop ?? "";
    const existing = (await sql`SELECT id FROM generated_images
      WHERE shop = ${shop} AND product_id = ${productId} AND variant_id = ${variantId}
      AND style = ${style} AND output_url = ${outputUrl} LIMIT 1`) as { id: number }[];
    if (existing.length)
      return json({ intent: "keep" as const, ok: true as const, duplicate: true as const, outputUrl });
    await sql`INSERT INTO generated_images (shop, product_id, variant_id, style, prompt_version, source_mode, provider, output_url)
      VALUES (${shop}, ${productId}, ${variantId}, ${style}, 'v1', ${sourceMode}, 'muse-image-1.0', ${outputUrl})`;
    return json({ intent: "keep" as const, ok: true as const, duplicate: false as const, outputUrl });
  } catch {
    return json({ intent: "keep" as const, ok: false as const, error: "Could not save this image — try again." }, { status: 500 });
  }
}

async function logTag(mediaId: string, variantId: string, status: string, detail: string) {
  try {
    const sql = db();
    const shops = (await sql`SELECT shop FROM shops LIMIT 1`) as { shop: string }[];
    await sql`INSERT INTO tag_events (shop, media_id, variant_id, status, detail)
      VALUES (${shops[0]?.shop ?? ""}, ${mediaId}, ${variantId}, ${status}, ${detail.slice(0, 300)})`;
  } catch {
    // logging never breaks the tagging response
  }
}

const qs = (p: Record<string, string>) =>
  `?${Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;

export default function Connect() {
  const { hint, ig, reels, reelsError, rTotal, rPage, rPages, products, productsError, total, page, pages,
    q, rq, productId, variantId, reelId, genStyle, selReel, selProduct, selVariant, taggedHere, genHistory } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const tagResult = result?.intent === "tag" ? result : null;
  const genResult = result?.intent === "generate" ? result : null;
  const keepResult = result?.intent === "keep" ? result : null;
  const hasStyleHistory = genStyle ? genHistory.some((h) => h.style === genStyle) : false;
  const keep = { q, rq, product: productId, variant: variantId, reel: reelId, style: genStyle };
  const complete = Boolean(selReel && selVariant);
  return (
    <main className="r2ac-wrap">
      <header className="r2ac-brand" aria-label="Reel2AICart">
        <span className="r2ac-mark" aria-hidden="true" />
        <strong style={{ fontSize: 22, color: "#0f4c4a" }}>
          Reel2<span style={{ color: "#ff7a5c" }}>AI</span>Cart
        </strong>
      </header>
      <p style={{ marginTop: 12 }}>
        <a className="btn btn-ghost" href="/">Back to dashboard</a>
      </p>

      <section className="r2ac-card" style={{ marginTop: 16 }}>
        <h2>Tag Instagram reels with your products</h2>
        <p>
          Pick a reel on the left, a product and variant on the right, check the
          review below, then tag it. Tagging calls Instagram product tags, so shoppers
          see View Products on the reel and land on your product pages with attribution.
        </p>
        <p>
          <small>
            Status: {hint} Instagram is {ig ? "connected" : "missing keys - set META_GRAPH_TOKEN + IG_USER_ID in Vercel env"}.
            Expected outcome after tagging: a green confirmation here and product tags visible on
            the reel on mobile within minutes. Failures show the exact account error, never a blank page.
          </small>
        </p>
      </section>

      <div className="r2ac-cols">
        <section className="r2ac-card" aria-label="Instagram reels">
          <h2>1. Pick a reel</h2>
          {reelsError ? (
            <p role="alert" className="r2ac-err">{reelsError}</p>
          ) : (
            <>
              <Form method="get" aria-label="Search reels">
                <label htmlFor="rq">Search reels</label><br />
                <input id="rq" name="rq" type="search" defaultValue={rq} placeholder="e.g. ballerina" />{" "}
                <input type="hidden" name="q" value={q} />
                <input type="hidden" name="product" value={productId} />
                <input type="hidden" name="variant" value={variantId} />
                <input type="hidden" name="pg" value={String(page)} />
                <button type="submit" className="btn btn-ghost">Search</button>
              </Form>
              <div role="list" aria-label="Recent reels">
                {reels.map((reel, i) => {
                  const on = reel.id === reelId;
                  return (
                    <a key={reel.id} role="listitem" href={qs({ ...keep, reel: reel.id })}
                      aria-current={on || undefined}
                      className={`r2ac-row ${i % 2 ? "r2ac-b" : "r2ac-a"}`}
                      style={{ textDecoration: "none", color: "inherit", border: on ? "2px solid #0f4c4a" : "2px solid transparent" }}>
                      {reel.thumbnail_url ? (
                        <img src={reel.thumbnail_url} alt="" loading="lazy" />
                      ) : reel.media_type === "VIDEO" && reel.media_url ? (
                        <video muted playsInline preload="metadata" src={reel.media_url} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, flex: "none" }} aria-label="Video preview" />
                      ) : (
                        <span className="r2ac-ph" aria-hidden="true">
                          {(reel.caption ?? reel.id).replace(/^[^A-Za-z0-9]+/, "").charAt(0).toUpperCase() || "R"}
                        </span>
                      )}
                      <span>
                        <strong>{on ? "✓ " : ""}{reel.caption?.slice(0, 80) || "(no caption)"}</strong>
                        <br />
                        <small>{reel.id} · {reel.timestamp?.slice(0, 10)}</small>
                        {taggedHere[reel.id] && (
                          <>
                            <br />
                            <small className={taggedHere[reel.id].status === "ok" ? "r2ac-ok" : "r2ac-err"}>
                              {taggedHere[reel.id].status === "ok"
                                ? `Tagged here on ${taggedHere[reel.id].when}`
                                : `Tag attempt failed ${taggedHere[reel.id].when}`}
                            </small>
                          </>
                        )}
                      </span>
                    </a>
                  );
                })}
                {reels.length === 0 && <p><small>No reels match this search.</small></p>}
              </div>
              <div className="r2ac-pager">
                <a className="btn btn-ghost" aria-disabled={rPage <= 1} href={rPage <= 1 ? "#" : qs({ ...keep, rpg: String(rPage - 1) })}>Prev</a>
                <small>Page {rPage} of {rPages} ({rTotal} reels)</small>
                <a className="btn btn-ghost" aria-disabled={rPage >= rPages} href={rPage >= rPages ? "#" : qs({ ...keep, rpg: String(rPage + 1) })}>Next</a>
              </div>
            </>
          )}
        </section>

        <section className="r2ac-card" aria-label="Shopify products">
          <h2>2. Pick a product</h2>
          {productsError ? (
            <p role="alert" className="r2ac-err">{productsError}</p>
          ) : (
            <>
              <Form method="get" aria-label="Search products">
                <label htmlFor="q">Search products</label><br />
                <input id="q" name="q" type="search" defaultValue={q} placeholder="e.g. gown" />{" "}
                <input type="hidden" name="rq" value={rq} />
                <input type="hidden" name="reel" value={reelId} />
                <input type="hidden" name="variant" value={variantId} />
                <input type="hidden" name="rpg" value={String(rPage)} />
                <button type="submit" className="btn btn-ghost">Search</button>
              </Form>
              {products.map((p, i) => {
                const on = String(p.id) === productId;
                return (
                  <a key={p.id} href={qs({ ...keep, product: String(p.id), variant: "", pg: "1" }) + (p.variants.length > 1 ? "#pick" : "")}
                    aria-current={on || undefined}
                    className={`r2ac-row ${i % 2 ? "r2ac-b" : "r2ac-a"}`}
                    style={{ textDecoration: "none", color: "inherit", border: on ? "2px solid #0f4c4a" : "2px solid transparent" }}>
                    {p.image ? (
                      <img src={p.image} alt="" loading="lazy" />
                    ) : (
                      <span className="r2ac-ph" aria-hidden="true">{p.title.charAt(0).toUpperCase()}</span>
                    )}
                    <span style={{ flex: 1 }}>
                      <strong>{on ? "✓ " : ""}{p.title}</strong>
                      <br />
                      <small>{p.variants.length} variant(s)</small>
                    </span>
                  </a>
                );
              })}
              {products.length === 0 && <p><small>No products match this search.</small></p>}
              <div className="r2ac-pager">
                <a className="btn btn-ghost" aria-disabled={page <= 1} href={page <= 1 ? "#" : qs({ ...keep, pg: String(page - 1) })}>Prev</a>
                <small>Page {page} of {pages} ({total} products)</small>
                <a className="btn btn-ghost" aria-disabled={page >= pages} href={page >= pages ? "#" : qs({ ...keep, pg: String(page + 1) })}>Next</a>
              </div>
              {selProduct && selProduct.variants.length > 1 && (
                <div id="pick" className="r2ac-modal" role="dialog" aria-label={`Variants of ${selProduct.title}`}>
                  <div className="r2ac-box">
                    <h3>Variant of {selProduct.title}</h3>
                    <p><small>Sent as the Meta catalog product ID, synced from Shopify by the Facebook and Instagram sales channel.</small></p>
                      <div role="list" aria-label="Variants">
                        {selProduct.variants.map((v) => (
                          <p key={v.id}>
                            <a className="btn btn-ghost" href={qs({ ...keep, product: String(selProduct.id), variant: String(v.id) })}>
                              {String(v.id) === variantId ? "✓ " : ""}{v.title} - ${v.price}
                            </a>{" "}
                            <small>({v.id})</small>
                          </p>
                        ))}
                      </div>
                    <p style={{ marginTop: 12 }}>
                      <a className="btn btn-primary" href="#">Done</a>
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <section className="r2ac-card" style={{ marginTop: 20 }} aria-label="Generate product image">
        <h2>3. Generate product image <small>(optional)</small></h2>
        {!selProduct ? (
          <p><small>Pick a product above to unlock image generation.</small></p>
        ) : (
          <>
            <p><small>Styles keep your picks — switching never loses ?reel ?product ?variant. Generation can take up to a minute.</small></p>
            <div role="list" aria-label="Image styles" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {STYLES.map((s) => (
                <a key={s} role="listitem" href={qs({ ...keep, style: s })}
                  aria-current={s === genStyle || undefined} className="btn btn-ghost"
                  style={s === genStyle ? { border: "2px solid #0f4c4a" } : undefined}>
                  {s === genStyle ? "✓ " : ""}{s}
                </a>
              ))}
            </div>
            <Form method="post" aria-label="Generate product image" style={{ marginTop: 12 }}>
              <input type="hidden" name="intent" value="generate" />
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="variantId" value={variantId} />
              <input type="hidden" name="style" value={genStyle} />
              <input type="hidden" name="productTitle" value={selProduct.title} />
              <input type="hidden" name="variantTitle" value={selVariant?.title ?? ""} />
              <input type="hidden" name="referenceImageUrl" value={selProduct.image ?? ""} />
              <button type="submit" className="btn btn-primary" disabled={!genStyle || nav.state !== "idle"}>
                {nav.state !== "idle" ? "Generating…" : genResult?.ok || hasStyleHistory ? "Regenerate image" : "Generate image"}
              </button>
              {!genStyle && <p><small>Pick a style above to enable generation.</small></p>}
            </Form>
            {nav.state !== "idle" && <p role="status"><small>Generating your image — this can take up to a minute…</small></p>}
            {genResult?.ok && (
              <figure style={{ marginTop: 12 }}>
                <img src={genResult.outputUrl} alt={`Generated ${genStyle} image of ${selProduct.title}`}
                  loading="lazy" style={{ maxWidth: "100%", height: "auto", borderRadius: 8 }} />
                <figcaption><small>{genStyle} · {genResult.sourceMode === "with-image" ? "matched to product photo" : "interpreted from product name"}</small></figcaption>
              </figure>
            )}
            {genResult?.ok && !keepResult?.ok && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Form method="post" aria-label="Keep generated image">
                  <input type="hidden" name="intent" value="keep" />
                  <input type="hidden" name="productId" value={productId} />
                  <input type="hidden" name="variantId" value={variantId} />
                  <input type="hidden" name="style" value={genStyle} />
                  <input type="hidden" name="outputUrl" value={genResult.outputUrl} />
                  <input type="hidden" name="sourceMode" value={genResult.sourceMode} />
                  <button type="submit" className="btn btn-primary" disabled={nav.state !== "idle"}>Keep</button>
                </Form>
                <a className="btn btn-ghost" href={qs(keep)}>Discard</a>
              </div>
            )}
            {keepResult && (
              <p role={keepResult.ok ? "status" : "alert"} className={keepResult.ok ? "r2ac-ok" : "r2ac-err"}>
                {keepResult.ok
                  ? keepResult.duplicate ? "Already kept — exactly one record saved." : "Kept — it now appears in history below."
                  : keepResult.error}
              </p>
            )}
            {genHistory.length > 0 && (
              <div style={{ marginTop: 12 }} aria-label="Generated image history">
                <h3>History <small>(newest first)</small></h3>
                <div role="list" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {genHistory.map((h) => (
                    <figure key={h.id} role="listitem" style={{ margin: 0, width: 120 }}>
                      <img src={h.outputUrl} alt="" loading="lazy" style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8 }} />
                      <figcaption><small><strong>{h.style}</strong> · {h.sourceMode} · {h.when}</small></figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {genResult && !genResult.ok && <p role="alert" className="r2ac-err">{genResult.error}</p>}
      </section>

      <section className="r2ac-card" style={{ marginTop: 20 }} aria-label="Review and tag">
        <h2>4. Review and tag</h2>
        {(selReel || selProduct || selVariant) ? (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
              <tbody>
                {selReel && (
                  <tr>
                    <th scope="row" style={{ textAlign: "left", padding: "6px 12px 6px 0", verticalAlign: "top" }}>Reel</th>
                    <td style={{ padding: "6px 0" }}>
                      <strong>{selReel.caption?.slice(0, 80) || "(no caption)"}</strong><br /><small>{selReel.id} · {selReel.timestamp?.slice(0, 10)}</small>
                    </td>
                  </tr>
                )}
                {selProduct && (
                  <tr>
                    <th scope="row" style={{ textAlign: "left", padding: "6px 12px 6px 0", verticalAlign: "top" }}>Product</th>
                    <td style={{ padding: "6px 0" }}><strong>{selProduct.title}</strong></td>
                  </tr>
                )}
                {selVariant && (
                  <tr>
                    <th scope="row" style={{ textAlign: "left", padding: "6px 12px 6px 0", verticalAlign: "top" }}>Variant</th>
                    <td style={{ padding: "6px 0" }}><strong>{selVariant.title}</strong> - ${selVariant.price} <small>({selVariant.id})</small></td>
                  </tr>
                )}
              </tbody>
            </table>
            <p>
              <small><a href={qs({ q, rq, pg: String(page), rpg: String(rPage) })}>Clear</a></small>
            </p>
          </>
        ) : null}
        {complete ? (
          <Form method="post" aria-label="Tag products on the selected reel" style={{ marginTop: 12 }}>
            <input type="hidden" name="intent" value="tag" />
            <input type="hidden" name="mediaId" value={reelId} />
            <input type="hidden" name="variantId" value={variantId} />
            <button type="submit" className="btn btn-primary">Tag products on reel</button>
          </Form>
        ) : (
          <p style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" disabled>Pick a reel, product and variant above</button>
          </p>
        )}
        {tagResult && (
          <p role={tagResult.ok ? "status" : "alert"} className={tagResult.ok ? "r2ac-ok" : "r2ac-err"}>
            {tagResult.ok ? `Tagged reel ${tagResult.mediaId} - check the reel on mobile for View Products.` : tagResult.error}
          </p>
        )}
      </section>
    </main>
  );
}
