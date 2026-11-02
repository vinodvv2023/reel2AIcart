import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { tagInstagram } from "~/lib/activation/instagram";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";
import { db } from "~/lib/db";

// PRD §5 Step 2 + 5A: status, publishing model, reel picker (IG media with
// thumbnails) + product picker (search, thumbnails, variants) → product_tags.
// Tokens from Vercel env; no in-app OAuth exists or is needed.
type Reel = { id: string; caption?: string; thumbnail_url?: string; timestamp?: string };
type Variant = { id: number; title: string; price: string };
type Product = { id: number; title: string; image?: string; variants: Variant[] };

async function igMedia(): Promise<{ reels: Reel[]; error: string | null }> {
  const token = process.env.META_GRAPH_TOKEN ?? "";
  const ig = process.env.IG_USER_ID ?? "";
  if (!token || !ig) return { reels: [], error: "IG keys missing in Vercel env." };
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${ig}/media?fields=id,caption,thumbnail_url,timestamp&limit=25&access_token=${token}`,
    );
    if (!r.ok) return { reels: [], error: `IG API ${r.status} — token may be expired.` };
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
    if (!r.ok) return { products: [], error: `Shopify API ${r.status} — re-authorize the store.` };
    const { products } = (await r.json()) as { products: Product[] };
    return { products, error: null };
  } catch {
    return { products: [], error: "Shopify API unreachable." };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const productId = new URL(request.url).searchParams.get("product") ?? "";
  const [{ reels, error: reelsError }, { products, error: productsError }] = await Promise.all([
    igMedia(),
    shopProducts(),
  ]);
  const filtered = q
    ? products.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()))
    : products;
  return json({
    hint: humanizeCommerceError("{{IE_30010}}"),
    ig: Boolean(process.env.META_GRAPH_TOKEN && process.env.IG_USER_ID),
    reels,
    reelsError,
    products: filtered,
    productsError,
    q,
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

const badge = (on: boolean) => ({
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 999,
  fontSize: 12,
  color: "#fff",
  background: on ? "#0F4C4A" : "#FF7A5C",
});

const thumb: React.CSSProperties = { width: 64, height: 64, objectFit: "cover", borderRadius: 8 };
const pick: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  border: "1px solid #e5e0d8",
  borderRadius: 10,
  padding: 8,
  marginTop: 8,
  background: "#fff",
};

export default function Connect() {
  const { hint, ig, reels, reelsError, products, productsError, q, productId } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const selected = products.find((p) => String(p.id) === productId);
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720 }}>
      <h1 style={{ color: "#0F4C4A" }}>Connect Instagram</h1>
      <p role="status">{hint}</p>
      <p>
        Instagram <span style={badge(ig)}>{ig ? "connected" : "missing key"}</span>
        {!ig && <small> — set META_GRAPH_TOKEN + IG_USER_ID in Vercel env</small>}
      </p>

      <h2>1. Pick a reel</h2>
      {reelsError ? (
        <>
          <p role="alert" style={{ color: "#FF7A5C" }}>{reelsError}</p>
          <p><small>Fallback: numeric media ID only works via the Graph API list — see “Finding a reel ID” below.</small></p>
        </>
      ) : (
        <div role="radiogroup" aria-label="Recent reels">
          {reels.map((reel) => (
            <label key={reel.id} style={pick}>
              <input type="radio" name="mediaId" value={reel.id} form="tagform" required />
              {reel.thumbnail_url && (
                <img src={reel.thumbnail_url} alt="" loading="lazy" style={thumb} />
              )}
              <span>
                <strong>{reel.caption?.slice(0, 80) || "(no caption)"}</strong>
                <br />
                <small>
                  {reel.id} · {reel.timestamp?.slice(0, 10)}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary>Finding a reel ID manually</summary>
        <ol style={{ paddingLeft: 20, display: "grid", gap: 4 }}>
          <li>Instagram does not show numeric media IDs anywhere in the app — the link you copy (instagram.com/reel/ABC123/) holds a shortcode, which this form cannot use.</li>
          <li>Reliable path: open the Graph API list in your browser (signed in as the business account):<br />
            <code>graph.facebook.com/v19.0/YOUR_IG_USER_ID/media?fields=id,caption,timestamp&amp;access_token=YOUR_TOKEN</code><br />
            (both values are in Vercel env) and copy the <code>id</code> — or just use the picker above, which reads the same list.</li>
        </ol>
      </details>

      <h2>2. Pick a product + variant</h2>
      {productsError ? (
        <p role="alert" style={{ color: "#FF7A5C" }}>{productsError}</p>
      ) : (
        <>
          <Form method="get" aria-label="Search products">
            <label htmlFor="q">Search products</label>{" "}
            <input id="q" name="q" defaultValue={q} placeholder="e.g. gown" />{" "}
            <button type="submit">Search</button>
          </Form>
          {products.map((p) => (
            <div key={p.id} style={pick}>
              {p.image && <img src={p.image} alt="" loading="lazy" style={thumb} />}
              <span style={{ flex: 1 }}>
                <strong>{p.title}</strong>
                <br />
                <small>{p.variants.length} variant(s)</small>
              </span>
              <a href={`?q=${encodeURIComponent(q)}&product=${p.id}`}>Select</a>
            </div>
          ))}
          {selected && (
            <fieldset style={{ marginTop: 12 }}>
              <legend>Variant of {selected.title}</legend>
              {selected.variants.map((v) => (
                <label key={v.id} style={{ display: "block", marginTop: 6 }}>
                  <input type="radio" name="variantId" value={v.id} form="tagform" required />{" "}
                  {v.title} — ${v.price} <small>({v.id})</small>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}

      <h2>3. Tag it</h2>
      <Form method="post" id="tagform" aria-label="Tag products on the selected reel">
        <button type="submit">Tag products on reel</button>
      </Form>
      {result && (
        <p role={result.ok ? "status" : "alert"} style={{ color: result.ok ? "#0F4C4A" : "#FF7A5C" }}>
          {result.ok ? `Tagged reel ${result.mediaId} ✓ — check the reel on mobile for View Products.` : result.error}
        </p>
      )}
    </main>
  );
}
