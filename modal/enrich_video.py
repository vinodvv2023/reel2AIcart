"""PRD L2 Enrichment — runs ONCE per new video hash on Modal A10G.
Input: video_url + 3 hero image urls. Output: JSON + embedding → Neon.
Online path never calls this; agents hit video_cache instead ($0 vs $0.30)."""
import hashlib
import modal

app = modal.App("reel2aicart-enrich")
image = modal.Image.debian_slim().pip_install("httpx", "pgvector", "psycopg2-binary")


@app.function(image=image, gpu="A10G", timeout=300, secrets=[modal.Secret.from_name("neon")])
def enrich_video(video_url: str, hero_images: list[str]) -> dict:
    import os
    import psycopg2

    video_hash = hashlib.sha256(video_url.encode()).hexdigest()
    # TODO: Muse Spark Open vision call here → summary + embedding
    summary = {"video_url": video_url, "hero_images": len(hero_images)}
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO video_embeddings (id, video_hash, summary) VALUES (%s,%s,%s)"
        " ON CONFLICT (video_hash) DO NOTHING",
        (video_hash, video_hash, psycopg2.extras.Json(summary)),
    )
    cur.execute(
        "INSERT INTO video_cache (video_id, summary) VALUES (%s,%s)"
        " ON CONFLICT (video_id) DO NOTHING",
        (video_hash, psycopg2.extras.Json(summary)),
    )
    conn.commit()
    return {"video_hash": video_hash, "status": "enriched"}
