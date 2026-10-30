"""PRD L2 Enrichment — runs ONCE per new video hash on Modal A10G.
Input: video_url + 3 hero image urls. Output: JSON + embedding → Neon.
Online path never calls this; agents hit video_cache instead ($0 vs $0.30)."""
import hashlib
import modal

app = modal.App("reel2aicart-enrich")
image = modal.Image.debian_slim().pip_install("httpx", "pgvector", "psycopg2-binary")


@app.function(image=image, gpu="A10G", timeout=300)
def enrich_video(video_url: str, hero_images: list[str]) -> dict:
    video_hash = hashlib.sha256(video_url.encode()).hexdigest()
    # TODO Day 3-4: call Muse Spark Open vision here, write to Neon video_embeddings + video_cache
    return {"video_hash": video_hash, "status": "queued", "hero_images": len(hero_images)}
