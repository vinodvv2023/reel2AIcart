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
        parsed = _vision_muse(video_url, hero_images)
        if parsed:
            return _contract_from_muse(video_url, hero_images, shop, product_id, parsed)
        print("[vision] muse failed — heuristic fallback")
    elif provider == "gemini":
        print("[vision] gemini client lands post-hackathon — heuristic fallback")
    elif provider != "heuristic":
        print(f"[vision] unknown provider={provider} — heuristic fallback")
    return _build_summary(video_url, hero_images, shop, product_id)


def _vision_muse(video_url: str, hero_images: list[str]) -> dict | None:
    """Muse Spark multimodal summary (Meta Model API, OpenAI-compatible chat).

    Returns {"products": [{"sku_hint": str, "detail": str}], "scene": str}
    or None. All config via env (META_API_KEY/META_BASE_URL/MUSE_VISION_MODEL)
    so model IDs track dev.meta.ai without code changes.
    """
    import json
    import os

    import httpx

    key = os.environ.get("MODEL_API_KEY", os.environ.get("META_API_KEY", ""))
    base = os.environ.get("META_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
    model = os.environ.get("MUSE_VISION_MODEL", "")
    if not key or not base or not model:
        print("[vision:muse] missing MODEL_API_KEY/META_BASE_URL/MUSE_VISION_MODEL")
        return None
    parts: list[dict] = [{
        "type": "text",
        "text": ("List each distinct product visible. Respond ONLY with JSON: "
                 '{"products": [{"sku_hint": "short name", "detail": "color/material in 6 words"}], "scene": "one line"}.'),
    }]
    for u in (hero_images or [])[:3]:
        parts.append({"type": "image_url", "image_url": {"url": u}})
    if not hero_images and video_url:
        parts[0]["text"] += f" No images provided; video URL for context only: {video_url}."
    try:
        r = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "messages": [{"role": "user", "content": parts}],
                  "reasoning_effort": "minimal", "max_tokens": 600},
            timeout=120,
        )
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        content = msg.get("content") or msg.get("reasoning_content") or ""
        if isinstance(content, list):  # content-block shape: join text parts
            content = "".join(
                p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
            )
        data = json.loads(content[content.index("{"): content.rindex("}") + 1])
        if not isinstance(data.get("products"), list):
            raise ValueError("no products[] in response")
        return data
    except Exception as exc:
        detail = ""
        resp = getattr(exc, "response", None)
        if resp is not None:
            try:
                detail = f" body={resp.text[:300]}"
            except Exception:
                pass
        print(f"[vision:muse] failed: {str(exc)[:150]}{detail}")
        return None


def _contract_from_muse(video_url: str, hero_images: list[str], shop: str, product_id, parsed: dict) -> dict:
    """Map a Muse vision response onto the widget/MCP contract (stable keys)."""
    import time

    products = parsed.get("products", [])[:3]
    marks = [0, 8, 15][: max(1, len(products))]
    timeline = [
        {"t": t, "sku_hint": str(p.get("sku_hint", f"look-{i + 1}")), "pdp_url": ""}
        for i, (t, p) in enumerate(zip(marks, products or [{}]))
    ]
    seed = f"{parsed.get('scene', '')} {' '.join(str(p.get('detail', '')) for p in products)}".strip()
    return {
        "video_url": video_url,
        "hero_images": (hero_images or [])[:3],
        "timeline": timeline,
        "product_id": product_id,
        "pdp_url": f"https://{shop}/products" if shop else "",
        "text_seed": seed or video_url,
        "provider": "muse-spark-vision-v1",
        "enriched_at": int(time.time()),
    }


def _embed_for(text: str, provider: str) -> tuple[list[float], str]:
    """Route to the selected embedder; hash fallback keeps rows writable."""
    vec: list[float] | None = None
    tag = "hash-lcg-v1"
    if provider == "muse":
        vec = _embed_muse(text)
        tag = "muse-embed-v1" if vec else "hash-lcg-v1"
    elif provider == "deepinfra":
        vec = _embed_deepinfra(text)
        tag = "deepinfra-bge-v1" if vec else "hash-lcg-v1"
    elif provider != "hash":
        print(f"[embed] unknown provider={provider} — hash fallback")
    return (vec or _text_embedding(text)), tag


def _embed_muse(text: str) -> list[float] | None:
    """Embeddings via Meta Model API when MUSE_EMBED_MODEL is set, else None.

    Falls back to hash so enrichment never hard-fails on a missing embedder —
    vision (the judged surface) stays Muse regardless.
    """
    import os

    import httpx

    key = os.environ.get("MODEL_API_KEY", os.environ.get("META_API_KEY", ""))
    base = os.environ.get("META_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
    model = os.environ.get("MUSE_EMBED_MODEL", "")
    if not key or not base or not model:
        print("[embed:muse] no MUSE_EMBED_MODEL — hash fallback")
        return None
    try:
        r = httpx.post(
            f"{base}/embeddings",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "input": text},
            timeout=60,
        )
        r.raise_for_status()
        return _fit_1024(r.json()["data"][0]["embedding"])
    except Exception as exc:
        print(f"[embed:muse] failed: {str(exc)[:150]}")
        return None


def _embed_deepinfra(text: str) -> list[float] | None:
    """bge-large (native 1024-dim) via DeepInfra OpenAI-compatible endpoint."""
    import os

    import httpx

    token = os.environ.get("DEEPINFRA_TOKEN", "")
    if not token:
        print("[embed:deepinfra] missing DEEPINFRA_TOKEN")
        return None
    model = os.environ.get("DEEPINFRA_EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    try:
        r = httpx.post(
            "https://api.deepinfra.com/v1/openai/embeddings",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"model": model, "input": text},
            timeout=60,
        )
        r.raise_for_status()
        return _fit_1024(r.json()["data"][0]["embedding"])
    except Exception as exc:
        print(f"[embed:deepinfra] failed: {str(exc)[:150]}")
        return None


def _fit_1024(vec: list[float]) -> list[float]:
    """Truncate/pad to 1024 dims + L2-norm to match vector(1024) + hash parity."""
    import math

    v = [float(x) for x in vec[:1024]] + [0.0] * max(0, 1024 - len(vec))
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


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


@app.function(image=image, timeout=60, secrets=[modal.Secret.from_name("neon"), modal.Secret.from_name("modal-auth")])
@modal.fastapi_endpoint(method="POST", docs=True)
def ingest(payload: dict) -> dict:
    """Public HTTPS entry — Shopify webhook handler POSTs here (<100ms ack).

    Auth: Vercel (the only caller — Shopify can't set headers) embeds
    payload.secret, checked against the modal-auth secret. Wrong/missing
    secret → 401, nothing spawned. URL after `modal deploy` looks like:
    https://<workspace>--reel2aicart-enrich-ingest.modal.run
    Copy it into .env as MODAL_WEBHOOK_URL.
    """
    import os

    from fastapi import HTTPException

    if payload.pop("secret", "") != os.environ.get("MODAL_INGEST_SECRET", ""):
        raise HTTPException(status_code=401, detail="unauthorized")
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
