"""Muse-agent demo (§5): Meta Model API function-calling over our MCP tools.
Usage: .venv/Scripts/python scripts/agent_demo.py "maroon gown"
Needs MODEL_API_KEY in env (dev.meta.ai dashboard). Stdlib only."""
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.meta.ai/v1"
APP = os.environ.get("APP_URL", "https://reel2-aicart.vercel.app")
SHOP = os.environ.get("SHOP", "reel2aicart-test.myshopify.com")

TOOLS = [
    {"type": "function", "function": {
        "name": "search_products",
        "description": "Vector-ranked product search over the store's shoppable videos",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "get_video_summary",
        "description": "Cached summary JSON for one video",
        "parameters": {"type": "object", "properties": {
            "video_id": {"type": "string"}}, "required": ["video_id"]}}},
]


def key():
    for line in Path(".env").read_text(errors="replace").splitlines():
        if line.startswith("MODEL_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("MODEL_API_KEY", "")


def chat(messages, api_key):
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps({"model": "muse-spark-1.3-contributor",
                                 "messages": messages, "tools": TOOLS}).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["choices"][0]["message"]


def mcp(name, args):
    if name == "search_products":
        u = f"{APP}/mcp/{SHOP}?tool=search_products&query={urllib.parse.quote(args['query'])}"
    else:
        u = f"{APP}/api/video-summary?video_id={urllib.parse.quote(args['video_id'])}"
    with urllib.request.urlopen(u, timeout=30) as r:
        return json.load(r)


def main():
    api_key = key()
    if not api_key:
        raise SystemExit("MODEL_API_KEY missing: dev.meta.ai dashboard → create key → local .env")
    query = " ".join(sys.argv[1:]) or "maroon gown"
    messages = [
        {"role": "developer", "content": "You are a shopping assistant. Use tools for product questions. Answer with product names, prices if present, and PDP links."},
        {"role": "user", "content": query},
    ]
    for _ in range(4):
        msg = chat(messages, api_key)
        messages.append({"role": "assistant", "content": msg.get("content"),
                         "tool_calls": msg.get("tool_calls")})
        calls = msg.get("tool_calls") or []
        if not calls:
            print(msg.get("content"))
            return
        for c in calls:
            fn = c["function"]
            args = json.loads(fn.get("arguments", "{}"))
            try:
                out = mcp(fn["name"], args)
            except Exception as e:  # noqa: BLE001 - demo surface must report, not crash
                out = {"error": str(e)[:200]}
            messages.append({"role": "tool", "tool_call_id": c["id"],
                             "content": json.dumps(out)[:4000]})
    print("(stopped after 4 tool rounds)")


main()
