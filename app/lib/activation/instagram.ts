import { humanizeCommerceError } from "~/lib/shopify/commerce-errors";

// PRD §5 Step 5A: POST /{ig_media_id}/product_tags with updated_tags.
// product_id here is the META CATALOG product ID (synced from Shopify by the
// Facebook & Instagram sales channel), resolved by Meta's shop graph to the
// merchant PDP — the link to the store lives in Business settings, not in
// this payload. {{IE_}} → human msg; Graph errors surface as plain text.
// IG tags mobile-only; web reels show no View Products.
export async function tagInstagram(mediaId: string, variantId: string, token: string) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${mediaId}/product_tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      updated_tags: [{ product_id: variantId, x: 0.5, y: 0.5 }],
      access_token: token,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(humanizeCommerceError(data.error?.message ?? JSON.stringify(data)));
  return data;
}
