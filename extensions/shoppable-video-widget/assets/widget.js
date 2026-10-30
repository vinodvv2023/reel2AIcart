// Reel2AICart widget: cached timeline drives product swap at t=00:08/00:15 (PRD §5 Step 5B).
// Lazy: fetches /api/video-summary once, sets _shopify_video cookie for attribution.
(async () => {
  const root = document.querySelector("[data-reel2aicart-widget]");
  if (!root) return;
  const videoId = root.getAttribute("data-video-id");
  document.cookie = `_shopify_video=${videoId};path=/;max-age=2592000`;
  const res = await fetch(`/api/video-summary?video_id=${videoId}`);
  if (!res.ok) return;
  const { summary } = await res.json();
  const rail = root.querySelector("[data-r2ac-products]");
  const timeline = summary?.timeline ?? [];
  const render = (t) => {
    const hit = [...timeline].reverse().find((e) => e.t <= t) ?? timeline[0];
    if (hit && rail) rail.innerHTML = `<a href="${hit.pdp_url}">${hit.sku_hint} @ ${hit.t}</a>`;
  };
  root.querySelector("video")?.addEventListener("timeupdate", (e) => render(e.target.currentTime));
  render(0);
})();
