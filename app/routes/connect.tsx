import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";

// PRD §5 Step 2: Connect IG Graph + YouTube Data API + Commerce health check.
// Loader exposes presence booleans only — never secret values.
export async function loader() {
  return json({
    hint: humanizeCommerceError("{{IE_30010}}"),
    ig: Boolean(process.env.META_GRAPH_TOKEN && process.env.IG_USER_ID),
    yt: Boolean(process.env.YOUTUBE_API_KEY),
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

export default function Connect() {
  const { hint, ig, yt } = useLoaderData<typeof loader>();
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 640 }}>
      <h1 style={{ color: "#0F4C4A" }}>Connect Instagram + YouTube</h1>
      <p role="status">{hint}</p>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        <li>
          Instagram <span style={badge(ig)}>{ig ? "connected" : "missing key"}</span>
          {!ig && <small> — set META_GRAPH_TOKEN + IG_USER_ID in .env</small>}
        </li>
        <li>
          YouTube <span style={badge(yt)}>{yt ? "connected" : "missing key"}</span>
          {!yt && <small> — set YOUTUBE_API_KEY in .env</small>}
        </li>
      </ul>
      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <form method="post" action="/auth/instagram">
          <label htmlFor="ig-submit" style={{ display: "none" }}>
            Connect Instagram account
          </label>
          <button id="ig-submit" type="submit">
            Connect Instagram
          </button>
        </form>
        <form method="post" action="/auth/youtube">
          <label htmlFor="yt-submit" style={{ display: "none" }}>
            Connect YouTube account
          </label>
          <button id="yt-submit" type="submit">
            Connect YouTube
          </button>
        </form>
      </div>
    </main>
  );
}
