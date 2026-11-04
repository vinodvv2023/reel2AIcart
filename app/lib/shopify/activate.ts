import { db } from "~/lib/db";
import { callTool } from "~/lib/mcp/tools";

const REQUIRED = ["read_products", "read_inventory", "read_content", "write_content", "read_orders"];

export type Activation = {
  token: boolean;
  missingScopes: string[];
  mcp: string;
  rows: number;
};

// webMCP readiness per shop: token live? scopes complete? MCP answering?
// Every run is recorded in shop_status_checks (history); latest = current.
// Never throws — callers treat failure as all-red.
export async function activateShop(shop: string): Promise<Activation> {
  const status: Activation = { token: false, missingScopes: [...REQUIRED], mcp: "error", rows: 0 };
  try {
    const sql = db();
    const shops = (await sql`SELECT access_token, scopes FROM shops WHERE shop = ${shop} LIMIT 1`) as {
      access_token: string;
      scopes: string;
    }[];
    if (!shops.length) return status;
    const granted = (shops[0].scopes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    status.missingScopes = REQUIRED.filter((s) => !granted.includes(s));
    try {
      const r = await fetch(`https://${shop}/admin/api/2026-10/shop.json`, {
        headers: { "X-Shopify-Access-Token": shops[0].access_token },
      });
      status.token = r.ok;
    } catch {
      status.token = false;
    }
    try {
      const out = (await callTool(shop, "search_products", { query: "" })) as {
        results: unknown[];
      };
      status.rows = out.results.length;
      status.mcp = status.rows > 0 ? "ready" : "empty";
    } catch {
      status.mcp = "error";
    }
    await sql`INSERT INTO shop_status_checks (shop, token_ok, missing_scopes, mcp, rows)
      VALUES (${shop}, ${status.token}, ${status.missingScopes.join(",")}, ${status.mcp}, ${status.rows})`;
  } catch (e) {
    console.error("[activate] failed:", String(e));
  }
  return status;
}
