import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// Starts a fresh OAuth grant on demand. Unlike Test-app reinstalls (which
// reuse the existing grant and never hit /auth/callback), this always
// produces a code exchange → token upsert in shops.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  if (!shop) return redirect("/connect");
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY ?? "",
    scope: "read_products,read_inventory,read_content,write_content,read_orders",
    redirect_uri: "https://reel2-aicart.vercel.app/auth/callback",
    state: `${shop}:${Date.now()}`,
  });
  return redirect(`https://${shop}/admin/oauth/authorize?${params}`);
}
