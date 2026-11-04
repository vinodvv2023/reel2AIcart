import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { activateShop } from "~/lib/shopify/activate";

// Re-check button: re-runs activation for one shop, records history row,
// redirects back to the dashboard.
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const shop = String(form.get("shop") ?? "");
  if (shop) {
    try {
      await activateShop(shop);
    } catch {
      // recorded as all-red inside activateShop
    }
  }
  return redirect(shop ? `/?shop=${encodeURIComponent(shop)}` : "/");
}
