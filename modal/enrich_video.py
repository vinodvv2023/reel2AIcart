"""PRD L2 Enrichment — runs ONCE per new video hash on Modal A10G.
Input: video_url + 3 hero image urls. Output: JSON + embedding → Neon.
Online path never calls this; agents hit video_cache instead ($0 vs $0.30)."""
import hashlib
import modal

app = modal.App("reel2aicart-enrich")
image = modal.Image.debian_slim().pip_install("fastapi[standard]", "httpx", "pgvector", "psycopg2-binary")


@app.function(image=image, gpu="A10G", timeout=300, secrets=[modal.Secret.from_name("neon")])
def enrich_video(video_url: str, hero_images: list[str], shop: str = "", product_id=None) -> dict:
    import os
    import psycopg2
    import psycopg2.extras

    if not video_url:
        # Resolve product video via Shopify product-media GraphQL using the
        # stored shop token. Runs here (not in ingest) because only this
        # function reliably receives the neon secret.
        video_url = _product_video_url(shop, product_id)
    if not video_url and not hero_images:
        return {"video_hash": "", "status": "skipped", "reason": "no media"}
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


@app.function(image=image, timeout=60, secrets=[modal.Secret.from_name("neon")])
@modal.fastapi_endpoint(method="POST", docs=True)
def ingest(payload: dict) -> dict:
    """Public HTTPS entry — Shopify webhook handler POSTs here (<100ms ack).

    URL after `modal deploy` looks like:
    https://<workspace>--reel2aicart-enrich-ingest.modal.run
    Copy it into .env as MODAL_WEBHOOK_URL.
    """
    video_url = payload.get("video_url", "")
    hero_images = payload.get("hero_images", [])
    enrich_video.spawn(
        video_url, hero_images, payload.get("shop", ""), payload.get("product_id")
    )
    return {"ok": True, "spawned": True}


def _product_video_url(shop: str, product_id) -> str:
    """First external_video/media URL on the product, else ''."""
    import os
    import psycopg2

    if not shop or not product_id:
        return ""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute("SELECT access_token FROM shops WHERE shop = %s", (shop,))
    row = cur.fetchone()
    conn.close()
    if not row:
        return ""
    import httpx

    query = """{ product(id: "%s") { media(first: 10) { edges {
      node { ... on ExternalVideo { embeddedUrl originUrl }
             ... on Video { sources { url } }
             ... on MediaImage { image { url } } } } } } }""" % (
        f"gid://shopify/Product/{product_id}"
    )
    try:
        r = httpx.post(
            f"https://{shop}/admin/api/2026-10/graphql.json",
            headers={"X-Shopify-Access-Token": row[0], "Content-Type": "application/json"},
            json={"query": query},
            timeout=15,
        )
        edges = r.json()["data"]["product"]["media"]["edges"]
    except Exception:
        return ""
    for e in edges:
        node = e.get("node", {})
        url = node.get("embeddedUrl") or node.get("originUrl") or ""
        if url:
            return url
        for s in node.get("sources", []):
            if s.get("url"):
                return s["url"]
    return ""
