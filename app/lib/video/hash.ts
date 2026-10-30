import { createHash } from "node:crypto";
import { db } from "~/lib/db";

// PRD §5 Step 3 + §9: SHA256(video_url) dedupe. Skip Muse Spark if hash exists.
export function videoHash(videoUrl: string): string {
  return createHash("sha256").update(videoUrl).digest("hex");
}

export async function isNewVideo(videoUrl: string): Promise<boolean> {
  const sql = db();
  const rows = (await sql`
    SELECT 1 FROM video_embeddings WHERE video_hash = ${videoHash(videoUrl)} LIMIT 1`) as unknown[];
  return rows.length === 0;
}
