"""Bulk E2E: enrich docs/videos with Modal-parity embeddings + metrics + MCP probes.
Usage: .venv/Scripts/python scripts/bulk_e2e.py [--write] [--shop SHOP]
Default is dry-run (hash + embed timing only, no DB writes). --write upserts
62 rows tagged provider=bulk-local-v1 (cleanup: DELETE WHERE summary->>'provider'='bulk-local-v1').
Needs DATABASE_URL in .env; --write also needs psycopg2-binary in .venv."""
import argparse
import hashlib
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

DIM = 1024
STOP = set("a an the and with in on of to for is are at her his its from into out gently woman young".split())


def load_env(path=".env"):
    d = {}
    for line in Path(path).read_text(errors="replace").splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            d[k.strip()] = v.strip().strip('"')
    return d


def text_embedding(text, dim=DIM):  # parity: modal/enrich_video.py + lib/video/embed.ts
    seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "little")
    x = seed or 1
    vals = []
    for _ in range(dim):
        x = (1664525 * x + 1013904223) % 4294967296
        vals.append(x / 4294967296 * 2 - 1)
    n = math.sqrt(sum(v * v for v in vals)) or 1.0
    return [v / n for v in vals]


def words(name):
    return [w for w in re.split(r"[^a-z]+", name.lower()) if w and w not in STOP]


def bge_embed(text, token):
    """bge-large via DeepInfra (native 1024-dim), L2-normed like Modal rows."""
    req = urllib.request.Request(
        "https://api.deepinfra.com/v1/openai/embeddings",
        data=json.dumps({"model": "BAAI/bge-large-en-v1.5", "input": text}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        vec = json.load(r)["data"][0]["embedding"]
    n = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / n for v in vec]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--shop", default="reel2aicart-test.myshopify.com")
    ap.add_argument("--provider", choices=["hash", "bge"], default="hash",
                    help="embedding algorithm; bge needs DEEPINFRA_TOKEN (env or local .env)")
    args = ap.parse_args()
    token = ""
    if args.provider == "bge":
        token = os.environ.get("DEEPINFRA_TOKEN", "") or load_env().get("DEEPINFRA_TOKEN", "")
        if not token:
            raise SystemExit("DEEPINFRA_TOKEN missing: $env:DEEPINFRA_TOKEN='<token>' or add to local .env (gitignored)")
    files = sorted(Path("docs/videos").glob("*.mp4"))
    print(f"files: {len(files)}")
    conn = None
    if args.write:
        import psycopg2
        import psycopg2.extras

        conn = psycopg2.connect(load_env()["DATABASE_URL"])
        conn.autocommit = True
        globals()["psycopg2"] = psycopg2
        globals()["extras"] = psycopg2.extras
    freq: dict[str, int] = {}
    t0 = time.time()
    enriched = skipped = 0
    for f in files:
        h = hashlib.sha256(f.read_bytes()).hexdigest()
        w = words(f.stem)
        for x in set(w):
            freq[x] = freq.get(x, 0) + 1
        seed = f"{f.name} {' '.join(w)}"
        tag = "hash-lcg-v1"
        emb = text_embedding(seed)
        if args.write and args.provider == "bge":
            try:
                emb = bge_embed(seed, token)
                tag = "deepinfra-bge-v1"
            except Exception as e:
                print(f"  bge failed for {f.name}: {str(e)[:80]} — hash fallback")
        if args.write:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM video_embeddings WHERE video_hash=%s", (h,))
            if cur.fetchone():
                skipped += 1
                continue
            summary = {"video_url": f"local:{f.name}", "hero_images": [],
                       "timeline": [{"t": t, "sku_hint": f"look-{i + 1}", "pdp_url": ""} for i, t in enumerate([0, 8, 15])],
                       "product_id": None, "pdp_url": "", "text_seed": seed,
                       "provider": "bulk-local-v1", "providers": {"vision": "heuristic-v1", "embed": tag},
                       "enriched_at": int(time.time())}
            vec = "[" + ",".join(f"{v:.6f}" for v in emb) + "]"
            cur.execute("INSERT INTO video_embeddings (id, video_hash, embedding, summary, pdp_url) VALUES (%s,%s,%s::vector,%s,%s)"
                        " ON CONFLICT (video_hash) DO UPDATE SET embedding=EXCLUDED.embedding, summary=EXCLUDED.summary",
                        (h, h, vec, extras.Json(summary), ""))
            cur.execute("INSERT INTO video_cache (video_id, summary) VALUES (%s,%s)"
                        " ON CONFLICT (video_id) DO UPDATE SET summary=EXCLUDED.summary", (h, extras.Json(summary)))
            enriched += 1
        else:
            text_embedding(seed)  # timing parity only
            enriched += 1
    dt = time.time() - t0
    print(f"{'wrote' if args.write else 'hashed'}: {enriched} dupes-skipped: {skipped} in {dt:.1f}s ({enriched / max(dt, 0.01):.1f}/s)")
    probes = sorted(freq, key=lambda w: (freq[w], -len(w)))[:12]
    print("probes:", ", ".join(probes))
    base = os.environ.get("APP_URL", "https://reel2-aicart.vercel.app")
    for q in probes:
        u = f"{base}/mcp/{args.shop}?tool=search_products&query={urllib.parse.quote(q)}"
        s = time.time()
        try:
            r = json.load(urllib.request.urlopen(u, timeout=20))
            print(f"  q={q!r:18} rerank={r.get('rerank')} results={len(r.get('results', []))} {(time.time() - s) * 1000:.0f}ms")
        except Exception as e:
            print(f"  q={q!r:18} ERROR {str(e)[:100]}")
    if conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*), COUNT(embedding) FROM video_embeddings")
        print("video_embeddings total/with-vector:", cur.fetchone())
        conn.close()


main()
