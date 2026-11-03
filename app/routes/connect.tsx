import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { tagInstagram } from "~/lib/activation/instagram";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";
import { db } from "~/lib/db";

// Tag-a-reel workspace: reels left, products right. Server state only
// (q/rq/product/pg via GET), radios post natively. No client JS.
type Reel = { id: string; caption?: string; thumbnail_url?: string; timestamp?: string };
type Variant = { id: number; title: string; price: string };
type Product = { id: number; title: string; image?: string; variants: Variant[] };
const PER_PAGE = 8;

async function igMedia(): Promise<{ reels: Reel[]; error: string | null }> {
  const token = process.env.META_GRAPH_TOKEN ?? "";
  const ig = process.env.IG_USER_ID ?? "";
  if (!token || !ig) return { reels: [], error: "IG keys missing in Vercel env." };
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${ig}/media?fields=id,caption,thumbnail_url,timestamp&limit=25&access_token=${token}`,
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
    return {
      products: products.map((p) => ({ ...p, image: p.image?.src })),
      error: null,
    };
  } catch {
    return { products: [], error: "Shopify API unreachable." };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const rq = params.get("rq") ?? "";
  const productId = params.get("product") ?? "";
  const pg = Math.max(1, parseInt(params.get("pg") ?? "1", 10) || 1);
  const [{ reels, error: reelsError }, { products, error: productsError }] = await Promise.all([
    igMedia(),
    shopProducts(),
  ]);
  const matchedReels = rq
    ? reels.filter(
        (r) => (r.caption ?? "").toLowerCase().includes(rq.toLowerCase()) || r.id.includes(rq),
      )
    : reels;
  const matched = q
    ? products.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()))
    : products;
  const pages = Math.max(1, Math.ceil(matched.length / PER_PAGE));
  const page = Math.min(pg, pages);
  return json({
    hint: humanizeCommerceError("{{IE_30010}}"),
    ig: Boolean(process.env.META_GRAPH_TOKEN && process.env.IG_USER_ID),
    reels: matchedReels,
    reelsError,
    products: matched.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    productsError,
    total: matched.length,
    page,
    pages,
    q,
    rq,
    productId,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const mediaId = String(form.get("mediaId") ?? "").trim();
  const variantId = String(form.get("variantId") ?? "").trim();
  if (!mediaId || !variantId)
    return json({ ok: false as const, error: "Pick a reel and a variant below." }, { status: 400 });
  const token = process.env.META_GRAPH_TOKEN ?? "";
  if (!token)
    return json({ ok: false as const, error: "META_GRAPH_TOKEN missing in Vercel env." }, { status: 500 });
  try {
    await tagInstagram(mediaId, variantId, token);
    return json({ ok: true as const, mediaId });
  } catch (e) {
    return json({ ok: false as const, error: e instanceof Error ? e.message : "Tagging failed." });
  }
}

const qs = (p: Record<string, string>) =>
  `?${Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;

export default function Connect() {
  const { hint, ig, reels, reelsError, products, productsError, total, page, pages, q, rq, productId } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const selected = products.find((p) => String(p.id) === productId);
  const keep = { q, rq, product: productId };
  return (
    <main className="r2ac-wrap">
      <style>{`
        .r2ac-wrap{max-width:1120px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif;background:#fcfcf9;color:#141413}
        .r2ac-brand{display:flex;align-items:center;gap:10px}
        .r2ac-mark{width:34px;height:34px;border-radius:10px;background:#0f4c4a;position:relative;flex:none}
        .r2ac-mark::after{content:"";position:absolute;left:12px;top:9px;border-left:12px solid #ff7a5c;border-top:8px solid transparent;border-bottom:8px solid transparent}
        .r2ac-cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px}
        @media (max-width:900px){.r2ac-cols{grid-template-columns:1fr}}
        .r2ac-card{border:1px solid #e8e2da;border-radius:12px;padding:16px;background:#fff}
        .r2ac-card h2{margin:0 0 4px;color:#0f4c4a}
        .r2ac-row{display:flex;gap:10px;align-items:center;border-radius:10px;padding:8px;margin-top:8px}
        .r2ac-a{background:#fdf3ec}.r2ac-b{background:#eef6f5}
        .r2ac-row img{width:64px;height:64px;object-fit:cover;border-radius:8px;flex:none}
        .r2ac-ph{width:64px;height:64px;border-radius:8px;flex:none;background:#f3ddd2;color:#0f4c4a;font-weight:700;font-size:24px;display:flex;align-items:center;justify-content:center}
        .btn{display:inline-block;border-radius:999px;padding:10px 18px;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none;border:1px solid transparent;transition:background-color 200ms,color 200ms}
        .btn-primary{background:#0f4c4a;color:#fff}.btn-primary:hover{background:#0d3f3d}.btn-primary:active{transform:scale(.98)}
        .btn-ghost{background:#fff;border-color:#0f4c4a;color:#0f4c4a}.btn-ghost:hover{background:#eef6f5}.btn-ghost:active{transform:scale(.98)}
        .btn[disabled]{opacity:.55;cursor:default}
        input[type=text],input[type=search]{padding:9px 12px;font-size:16px;border-radius:8px;border:1px solid #e8e2da;color:#141413;background:#fff}
        label{font-weight:600}
        :focus-visible{outline:2px solid #ff7a5c;outline-offset:2px}
        .r2ac-pager{display:flex;gap:10px;align-items:center;margin-top:12px}
        .r2ac-ok{color:#0f4c4a}.r2ac-err{color:#b3402a}
        .r2ac-modal{display:none}
        .r2ac-modal:target{display:flex;position:fixed;inset:0;background:rgba(20,20,19,.45);z-index:50;padding:24px}
        .r2ac-modal .r2ac-box{background:#fff;border-radius:12px;padding:20px;max-width:480px;width:100%;margin:auto}
        .r2ac-box h3{margin:0 0 8px;color:#0f4c4a}
      `}</style>

      <header className="r2ac-brand" aria-label="Reel2AICart">
        <span className="r2ac-mark" aria-hidden="true" />
        <strong style={{ fontSize: 22, color: "#0f4c4a" }}>
          Reel2<span style={{ color: "#ff7a5c" }}>AI</span>Cart
        </strong>
      </header>

      <section className="r2ac-card" style={{ marginTop: 16 }}>
        <h2>Tag Instagram reels with your products</h2>
        <p>
          This page links a reel to Shopify products. Pick a reel on the left, a product and
          variant on the right, then tag it. Tagging calls Instagram product tags, so shoppers
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
          <h2>Reels</h2>
          {reelsError ? (
            <p role="alert" className="r2ac-err">{reelsError}</p>
          ) : (
            <>
              <Form method="get" aria-label="Search reels">
                <label htmlFor="rq">Search reels</label><br />
                <input id="rq" name="rq" type="search" defaultValue={rq} placeholder="e.g. ballerina" />{" "}
                <input type="hidden" name="q" value={q} />
                <input type="hidden" name="product" value={productId} />
                <button type="submit" className="btn btn-ghost">Search</button>
              </Form>
              <div role="radiogroup" aria-label="Recent reels">
                {reels.map((reel, i) => (
                  <label key={reel.id} className={`r2ac-row ${i % 2 ? "r2ac-b" : "r2ac-a"}`}>
                    <input type="radio" name="mediaId" value={reel.id} form="tagform" required />
                    {reel.thumbnail_url ? (
                      <img src={reel.thumbnail_url} alt="" loading="lazy" />
                    ) : (
                      <span className="r2ac-ph" aria-hidden="true">
                        {(reel.caption ?? reel.id).replace(/^[^A-Za-z0-9]+/, "").charAt(0).toUpperCase() || "R"}
                      </span>
                    )}
                    <span>
                      <strong>{reel.caption?.slice(0, 80) || "(no caption)"}</strong>
                      <br />
                      <small>{reel.id} · {reel.timestamp?.slice(0, 10)}</small>
                    </span>
                  </label>
                ))}
                {reels.length === 0 && <p><small>No reels match this search.</small></p>}
              </div>
            </>
          )}
        </section>

        <section className="r2ac-card" aria-label="Shopify products">
          <h2>Products</h2>
          {productsError ? (
            <p role="alert" className="r2ac-err">{productsError}</p>
          ) : (
            <>
              <Form method="get" aria-label="Search products">
                <label htmlFor="q">Search products</label><br />
                <input id="q" name="q" type="search" defaultValue={q} placeholder="e.g. gown" />{" "}
                <input type="hidden" name="rq" value={rq} />{" "}
                <button type="submit" className="btn btn-ghost">Search</button>
              </Form>
              {products.map((p, i) => (
                <div key={p.id} className={`r2ac-row ${i % 2 ? "r2ac-b" : "r2ac-a"}`}>
                  {p.image ? (
                    <img src={p.image} alt="" loading="lazy" />
                  ) : (
                    <span className="r2ac-ph" aria-hidden="true">
                      {p.title.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span style={{ flex: 1 }}>
                    <strong>{p.title}</strong>
                    <br />
                    <small>{p.variants.length} variant(s)</small>
                  </span>
                  <a className="btn btn-ghost" href={qs({ ...keep, product: String(p.id), pg: "1" }) + "#pick"}>Select</a>
                </div>
              ))}
              {products.length === 0 && <p><small>No products match this search.</small></p>}
              <div className="r2ac-pager">
                <a className="btn btn-ghost" aria-disabled={page <= 1} href={page <= 1 ? "#" : qs({ ...keep, pg: String(page - 1) })}>Prev</a>
                <small>Page {page} of {pages} ({total} products)</small>
                <a className="btn btn-ghost" aria-disabled={page >= pages} href={page >= pages ? "#" : qs({ ...keep, pg: String(page + 1) })}>Next</a>
              </div>
              {selected && (
                <div id="pick" className="r2ac-modal" role="dialog" aria-label={`Variants of ${selected.title}`}>
                  <div className="r2ac-box">
                    <h3>Variant of {selected.title}</h3>
                    <p><small>Sent as the Meta catalog product ID, synced from Shopify by the Facebook and Instagram sales channel.</small></p>
                    {selected.variants.length === 1 ? (
                      <>
                        <input type="hidden" name="variantId" value={selected.variants[0].id} form="tagform" />
                        <p>
                          Only variant: <strong>{selected.variants[0].title}</strong> - $
                          {selected.variants[0].price} (auto-selected)
                        </p>
                      </>
                    ) : (
                      <div role="radiogroup" aria-label="Variants">
                        {selected.variants.map((v) => (
                          <label key={v.id} style={{ display: "block", marginTop: 6 }}>
                            <input type="radio" name="variantId" value={v.id} form="tagform" required />{" "}
                            {v.title} - ${v.price} <small>({v.id})</small>
                          </label>
                        ))}
                      </div>
                    )}
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

      <section className="r2ac-card" style={{ marginTop: 20 }}>
        <Form method="post" id="tagform" aria-label="Tag products on the selected reel">
          <button type="submit" className="btn btn-primary">Tag products on reel</button>
        </Form>
        {result && (
          <p role={result.ok ? "status" : "alert"} className={result.ok ? "r2ac-ok" : "r2ac-err"}>
            {result.ok
              ? `Tagged reel ${result.mediaId} - check the reel on mobile for View Products.`
              : result.error}
          </p>
        )}
      </section>
    </main>
  );
}
