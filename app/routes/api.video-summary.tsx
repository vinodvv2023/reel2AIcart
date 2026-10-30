import type { LoaderFunctionArgs } from "@remix-run/node";
import { db } from "~/lib/db";

// PRD §7 + §5 Step 5: ONLINE path — reads video_cache, no vision, <20ms.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get("video_id");
  if (!videoId) return Response.json({ error: "video_id required" }, { status: 400 });
  const sql = db();
  const rows = (await sql`SELECT summary FROM video_cache WHERE video_id = ${videoId} LIMIT 1`) as { summary: unknown }[];
  if (!rows.length) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(rows[0]);
}
