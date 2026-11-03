import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

// RFC 9728 discovery target (reached via vercel.json rewrite, since Remix
// flat routes cannot express a leading-dot path segment). Our reads are
// public: advertise the resource with no authorization servers so strict
// MCP clients proceed unauthenticated instead of failing a 404.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  const origin = new URL(request.url).origin;
  return json({
    resource: `${origin}/mcp/${shop}`,
    authorization_servers: [],
  });
}
