// PRD §5 Step 3: bulk pull shopify/products.json → Neon upsert (1000 SKUs).
// Minimal stub: fetch + upsert loop. Full pagination added in Day 3-4 slice.
export async function syncProducts(shop: string, token: string) {
  const res = await fetch(`https://${shop}/admin/api/2024-10/products.json?limit=250`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!res.ok) throw new Error(`shopify sync failed: ${res.status}`);
  const { products } = (await res.json()) as { products: unknown[] };
  return { count: products.length };
}
