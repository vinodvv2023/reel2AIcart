import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

// RFC 9728 discovery for MCP OAuth probing (codex/ChatGPT clients check it
// before tool registration). Our reads are public: advertise the resource
// with no authorization servers so strict clients proceed unauthenticated
// instead of reading a 404 as "server misconfigured".
export async function loader({ request, params }: LoaderFunctionArgs) {
  const origin = new URL(request.url).origin;
  return json({
    resource: `${origin}/mcp/${params.shopId}`,
    authorization_servers: [],
  });
}
