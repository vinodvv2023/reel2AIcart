// Reel2AICart widget: cached timeline drives product swap at t=00:08/00:15 (PRD §5 Step 5B).
// Lazy: fetches /api/video-summary once, sets _shopify_video cookie for attribution.
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const withUtm = (base, videoId, t) => {
    try {
      const u = new URL(base, location.origin);
      u.searchParams.set("utm_source", "reel2aicart");
      u.searchParams.set("utm_medium", "shoppable");
      u.searchParams.set("utm_campaign", videoId);
      u.searchParams.set("utm_content", String(t));
      return u.toString();
    } catch {
      return base;
    }
  };
  const init = async () => {
    const root = document.querySelector("[data-reel2aicart-widget]");
    if (!root) return;
    const videoId = root.getAttribute("data-video-id") || "";
    if (!videoId) return;
    document.cookie = `_shopify_video=${encodeURIComponent(videoId)};path=/;max-age=2592000;SameSite=Lax`;
    const rail = root.querySelector("[data-r2ac-products]");
    let timeline = [];
    try {
      const res = await fetch(`/api/video-summary?video_id=${encodeURIComponent(videoId)}`);
      if (res.ok) timeline = (await res.json()).summary?.timeline ?? [];
    } catch {
      return; // offline / API down — leave fallback content in place
    }
    if (!timeline.length || !rail) return;
    const render = (t) => {
      const hit = [...timeline].reverse().find((e) => e.t <= t) ?? timeline[0];
      if (!hit || !hit.pdp_url) return;
      rail.innerHTML = `<a href="${esc(withUtm(hit.pdp_url, videoId, hit.t))}">${esc(hit.sku_hint)} @ 00:${esc(String(hit.t).padStart(2, "0"))}</a>`;
    };
    root.querySelector("video")?.addEventListener("timeupdate", (e) => render(e.target.currentTime));
    render(0);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
