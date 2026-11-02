import { json, type ActionFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { tagInstagram } from "~/lib/activation/instagram";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";

// PRD §5 Step 2 + 5A: Instagram status, publishing model, and the Tag-a-reel
// form (media ID + variant → product_tags). Token comes from Vercel env
// (Meta Add-account wizard), never in-app OAuth — no connect button exists.
export async function loader() {
  return json({
    hint: humanizeCommerceError("{{IE_30010}}"),
    ig: Boolean(process.env.META_GRAPH_TOKEN && process.env.IG_USER_ID),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const mediaId = String(form.get("mediaId") ?? "").trim();
  const variantId = String(form.get("variantId") ?? "").trim();
  if (!mediaId || !variantId)
    return json({ ok: false as const, error: "Media ID and Variant ID are both required." }, { status: 400 });
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

const steps: string[] = [
  "Post the reel in Instagram as usual — publishing stays in IG, this app never re-uploads.",
  "Tag products on the reel below so View Products appears for mobile viewers.",
  "Show the same video on-site via the shoppable widget; PDP links carry the video_id for attribution.",
];

const field: React.CSSProperties = { display: "grid", gap: 4, marginTop: 12 };

export default function Connect() {
  const { hint, ig } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 640 }}>
      <h1 style={{ color: "#0F4C4A" }}>Connect Instagram</h1>
      <p role="status">{hint}</p>
      <p>
        Instagram <span style={badge(ig)}>{ig ? "connected" : "missing key"}</span>
        {!ig && <small> — set META_GRAPH_TOKEN + IG_USER_ID in Vercel env</small>}
      </p>
      <h2>How a video reaches your store</h2>
      <ol style={{ display: "grid", gap: 8, paddingLeft: 20 }}>
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <h2>Tag a reel</h2>
      <Form method="post" aria-label="Tag products on an Instagram reel">
        <div style={field}>
          <label htmlFor="mediaId">Reel media ID</label>
          <input id="mediaId" name="mediaId" required inputMode="numeric" placeholder="e.g. 17841463945253404" />
        </div>
        <div style={field}>
          <label htmlFor="variantId">Shopify variant ID</label>
          <input id="variantId" name="variantId" required inputMode="numeric" placeholder="e.g. 44834712345678" />
        </div>
        <button type="submit" style={{ marginTop: 16 }}>
          Tag products on reel
        </button>
      </Form>
      {result && (
        <p role={result.ok ? "status" : "alert"} style={{ color: result.ok ? "#0F4C4A" : "#FF7A5C" }}>
          {result.ok ? `Tagged reel ${result.mediaId} ✓` : result.error}
        </p>
      )}
    </main>
  );
}
