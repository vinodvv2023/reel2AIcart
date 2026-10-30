import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";

// PRD §5 Step 5A: POST /{ig_media_id}/product_tags. {{IE_}} → human msg + fallback.
// IG tags mobile-only; web https://www.instagram.com/myntra/reels/ shows no View Products.
export async function tagInstagram(mediaId: string, variantId: string, token: string) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${mediaId}/product_tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ product_id: variantId, access_token: token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(humanizeCommerceError(JSON.stringify(json)));
  return json;
}
