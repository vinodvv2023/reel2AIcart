import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { activateShop } from "~/lib/shopify/activate";

// Re-check button: re-runs activation for one shop, records history row,
// redirects back with a human summary so the dashboard can confirm completion.
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const shop = String(form.get("shop") ?? "");
  if (!shop) return redirect("/");
  let msg = "check failed to run";
  let ok = false;
  try {
    const s = await activateShop(shop);
    const parts = [
      s.token ? "token ok" : "token dead",
      s.missingScopes.length ? `missing ${s.missingScopes.join(",")}` : "scopes ok",
      `MCP ${s.mcp} (${s.rows} rows)`,
    ];
    const time = new Date().toISOString().slice(11, 16);
    ok = s.token && s.missingScopes.length === 0 && s.mcp === "ready";
    msg = `Re-check ${time} UTC - ${parts.join(", ")}`;
  } catch {
    msg = "Re-check failed to run";
  }
  return redirect(`/?shop=${encodeURIComponent(shop)}&recheck_ok=${ok ? "1" : "0"}&recheck_msg=${encodeURIComponent(msg)}`);
}
