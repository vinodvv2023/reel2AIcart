"""Phase-1 loop: _parse_vision against malformed Muse payloads (the dusky-rose class).

Runs the REAL function from modal/enrich_video.py with stubbed `modal`
import. Red = parser rejects; green = parser recovers.
"""
import json
import sys
import types

ROOT = r"C:\Users\xtrem\Downloads\python_proj\reel2AIcart"

# Stub the only top-level third-party import so no Modal env is needed.
def _deco(*a, **k):
    return lambda fn: fn


modal_stub = types.ModuleType("modal")
modal_stub.App = lambda *a, **k: types.SimpleNamespace(function=_deco)
modal_stub.Image = types.SimpleNamespace(
    debian_slim=lambda: types.SimpleNamespace(pip_install=lambda *a: None))
modal_stub.Secret = types.SimpleNamespace(from_name=lambda *a: None)
modal_stub.fastapi_endpoint = _deco
modal_stub.web_endpoint = _deco
sys.modules["modal"] = modal_stub
sys.path.insert(0, ROOT + "\\modal")

import enrich_video as ev


class Resp:
    def __init__(self, content):
        self._content = content

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


def case(name, payload):
    try:
        out = ev._parse_vision(Resp(payload))
    except Exception as exc:  # noqa: BLE001 — loop must never crash
        print(f"{name}: EXCEPTION {exc!r}")
        return False
    ok = bool(out and isinstance(out.get("products"), list))
    print(f"{name}: {'parsed' if ok else 'REJECTED'}")
    return ok


LONG = ('{"products": [{"sku_hint": "dusky rose silk saree", "detail": "muted mauve silk saree soft sheen"}, '
        '{"sku_hint": "gold jhumka", "detail": "temple gold jhumka pearl drops"}, '
        '{"sku_hint": "potli bag", "detail": "embroidered silk potli bag"}], '
        '"scene": "boutique rack warm light"}')
# Cut mid-second-product at char 245: the max_tokens / glitch class from the logs.
TRUNC245 = LONG[:245]
# Trailing comma class: comma before the array close, everything else intact.
TRAIL = LONG.replace('bag"}]}, "scene"', 'bag"},]}, "scene"')

results = {
    "valid": case("valid        ", LONG),
    "truncated-245": case("truncated-245", TRUNC245),
    "trailing-comma": case("trailing-comma", TRAIL),
}
red = [k for k, v in results.items() if k != "valid" and not v]
print("RED classes:", red if red else "none")
# Truncation is unrecoverable by design — but it must now leave evidence.
import io
from contextlib import redirect_stdout
buf = io.StringIO()
with redirect_stdout(buf):
    case("truncated-245", TRUNC245)
logged = "[DEBUG-vision] raw payload:" in buf.getvalue()
print("truncation leaves payload evidence:", logged)
sys.exit(0 if results["valid"] and results["trailing-comma"] and logged else 1)
