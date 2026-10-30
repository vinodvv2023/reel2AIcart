// PRD Pain 5: every pdp_url gets utm_source=reel2aicart + campaign=video_id + content=t.
export function pdpUrl(base: string, videoId: string, t: string): string {
  const u = new URL(base);
  u.searchParams.set("utm_source", "reel2aicart");
  u.searchParams.set("utm_medium", "shoppable");
  u.searchParams.set("utm_campaign", videoId);
  u.searchParams.set("utm_content", t);
  return u.toString();
}
