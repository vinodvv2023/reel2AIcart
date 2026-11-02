import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";

// PRD §5 Step 2: Instagram connection status + how publishing works.
// No connect button: the IG token is provisioned via Meta's Add-account
// wizard into Vercel env (META_GRAPH_TOKEN + IG_USER_ID), never via in-app
// OAuth — a POST form here would 404 against a route that must not exist.
export async function loader() {
  return json({
    hint: humanizeCommerceError("{{IE_30010}}"),
    ig: Boolean(process.env.META_GRAPH_TOKEN && process.env.IG_USER_ID),
  });
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
  "Tag products on the reel (media ID + variant) so View Products appears for mobile viewers.",
  "Show the same video on-site via the shoppable widget; PDP links carry the video_id for attribution.",
];

export default function Connect() {
  const { hint, ig } = useLoaderData<typeof loader>();
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
    </main>
  );
}
