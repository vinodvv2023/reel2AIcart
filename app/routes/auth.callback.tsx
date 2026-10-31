import { createHmac, timingSafeEqual } from "node:crypto";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { db } from "~/lib/db";

// OAuth callback: verifies HMAC, exchanges code, upserts the shop token.
function validHmac(params: URLSearchParams, secret: string): boolean {
  const hmac = params.get("hmac") ?? "";
  const pairs = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(pairs).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const shop = params.get("shop") ?? "";
  const code = params.get("code") ?? "";
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  const key = process.env.SHOPIFY_API_KEY ?? "";

  if (!shop || !code) return json({ ok: false, error: "missing shop or code" }, { status: 400 });
  if (!validHmac(params, secret)) return json({ ok: false, error: "bad hmac" }, { status: 401 });

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: key, client_secret: secret, code }),
  });
  if (!res.ok) return json({ ok: false, error: `token exchange failed: ${res.status}` }, { status: 502 });
  const { access_token, scope } = (await res.json()) as { access_token?: string; scope?: string };
  if (!access_token) return json({ ok: false, error: "no token returned" }, { status: 502 });
  const sql = db();
  await sql`INSERT INTO shops (shop, access_token, scopes)
    VALUES (${shop}, ${access_token}, ${scope ?? ""})
    ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token, scopes = EXCLUDED.scopes, installed_at = NOW()`;
  return json({ ok: true, shop, scope: scope ?? "" });
}

export default function AuthCallback() {
  const data = useLoaderData<typeof loader>();
  if (!("ok" in data) || !data.ok)
    return (
      <main style={{ padding: 24 }}>
        <h1 style={{ color: "#FF7A5C" }}>Install failed</h1>
        <p>{(data as { error?: string }).error ?? "unknown error"}</p>
      </main>
    );
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: "#0F4C4A" }}>Connected ✓</h1>
      <p>
        <strong>{(data as { shop: string }).shop}</strong> installed with scopes:{" "}
        <code>{(data as { scope: string }).scope}</code>
      </p>
      <p>
        <a href={`/?shop=${(data as { shop: string }).shop}`}>Open dashboard →</a>
      </p>
    </main>
  );
}
