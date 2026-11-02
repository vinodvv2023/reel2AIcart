"""PRD L2 Enrichment — runs ONCE per new video hash on Modal A10G.
Input: video_url + 3 hero image urls. Output: JSON + embedding → Neon.
Online path never calls this; agents hit video_cache instead ($0 vs $0.30).

Provider switch (no code change to flip): Modal secret "app-config" holds
VISION_PROVIDER (muse|gemini) + EMBED_PROVIDER (muse|deepinfra|hash).
Keys live in "meta" (META_API_KEY), "gemini", "deepinfra" secrets —
create with placeholder values if unused; only the selected provider's
key must be real. Hackathon default: muse/muse (Meta Model API)."""
import hashlib
import modal

app = modal.App("reel2aicart-enrich")
image = modal.Image.debian_slim().pip_install("fastapi[standard]", "httpx", "pgvector", "psycopg2-binary")

SECRETS = [modal.Secret.from_name(n) for n in ("neon", "meta", "gemini", "deepinfra", "app-config")]


@app.function(image=image, gpu="A10G", timeout=300, secrets=SECRETS)
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
        print(f"[enrich] skip shop={shop} product={product_id}: no media")
        return {"video_hash": "", "status": "skipped", "reason": "no media"}
    video_hash = hashlib.sha256(video_url.encode()).hexdigest()
    vision, embed = _providers()
    summary = _vision_summary(video_url, hero_images, shop, product_id, vision)
    embedding, embed_tag = _embed_for(video_url + "|" + summary["text_seed"], embed)
    summary["providers"] = {"vision": summary.pop("provider"), "embed": embed_tag}
    print(f"[enrich] shop={shop} product={product_id} vision={summary['providers']['vision']} embed={embed_tag} dims={len(embedding)} looks={len(summary['timeline'])}")
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    vec = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
    cur.execute(
        "INSERT INTO video_embeddings (id, video_hash, embedding, summary, pdp_url) VALUES (%s,%s,%s::vector,%s,%s)"
        " ON CONFLICT (video_hash) DO UPDATE SET embedding = EXCLUDED.embedding,"
        " summary = EXCLUDED.summary, pdp_url = EXCLUDED.pdp_url",
        (video_hash, video_hash, vec, psycopg2.extras.Json(summary), summary["pdp_url"]),
    )
    cur.execute(
        "INSERT INTO video_cache (video_id, summary) VALUES (%s,%s)"
        " ON CONFLICT (video_id) DO UPDATE SET summary = EXCLUDED.summary",
        (video_hash, psycopg2.extras.Json(summary)),
    )
    conn.commit()
    return {"video_hash": video_hash, "status": "enriched", "providers": summary["providers"]}


def _providers() -> tuple[str, str]:
    """Selected providers from the app-config secret; hackathon default muse/muse."""
    import os

    return (os.environ.get("VISION_PROVIDER", "muse"), os.environ.get("EMBED_PROVIDER", "muse"))


def _vision_summary(video_url: str, hero_images: list[str], shop: str, product_id, provider: str) -> dict:
    """Muse Spark vision via Meta Model API; heuristic fallback on any failure."""
    if provider == "muse":
        print("[vision] muse client lands in next commit — heuristic fallback")
    elif provider != "heuristic":
        print(f"[vision] unknown provider={provider} — heuristic fallback")
    return _build_summary(video_url, hero_images, shop, product_id)


def _embed_for(text: str, provider: str) -> tuple[list[float], str]:
    """Route to the selected embedder; hash fallback keeps rows writable."""
    if provider == "muse":
        print("[embed] muse client lands in next commit — hash fallback")
    elif provider == "deepinfra":
        print("[embed] deepinfra client lands in next commit — hash fallback")
    elif provider != "hash":
        print(f"[embed] unknown provider={provider} — hash fallback")
    return _text_embedding(text), "hash-lcg-v1"


def _build_summary(video_url: str, hero_images: list[str], shop: str, product_id) -> dict:
    """Content-derived summary matching the widget/MCP contract.

    provider heuristic-v1: timeline + text_seed from real media (no vision
    API yet). Swap the body of this function for the Muse Spark vision call —
    keep the keys stable so widget.js / MCP need no changes.
    """
    import time

    marks = [0, 8, 15][: max(1, len(hero_images))]
    timeline = [
        {"t": t, "sku_hint": f"look-{i + 1}", "pdp_url": ""}
        for i, t in enumerate(marks)
    ]
    pdp_url = f"https://{shop}/products" if shop else ""
    seed = f"{video_url} {' '.join(hero_images)} shop={shop} product={product_id}"
    return {
        "video_url": video_url,
        "hero_images": hero_images[:3],
        "timeline": timeline,
        "product_id": product_id,
        "pdp_url": pdp_url,
        "text_seed": seed,
        "provider": "heuristic-v1",
        "enriched_at": int(time.time()),
    }


def _text_embedding(text: str, dim: int = 1024) -> list[float]:
    """Deterministic content-derived embedding (LCG over sha256 seed, L2-norm).

    Mirrors app/lib/video/embed.ts exactly — same seed + LCG must produce the
    same vector there so MCP query embeddings rank against these rows.
    provider tag records the algorithm version for future vision swap.
    """
    import math

    seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "little")
    x = seed or 1
    vals = []
    for _ in range(dim):
        x = (1664525 * x + 1013904223) % 4294967296
        vals.append(x / 4294967296 * 2 - 1)
    norm = math.sqrt(sum(v * v for v in vals)) or 1.0
    return [v / norm for v in vals]


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
    print(f"[ingest] shop={payload.get('shop')} product={payload.get('product_id')} heroes={len(hero_images)}")
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
        print(f"[media] no token for shop={shop}")
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
    except Exception as exc:
        print(f"[media] graphql failed shop={shop}: {exc}")
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
