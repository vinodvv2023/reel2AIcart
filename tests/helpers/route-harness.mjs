// Minimal action-test harness (T7, refs #8). No new dependencies: transpiles
// the repo's own TS/TSX with the installed `typescript` devDep and loads the
// result with stubbed platform edges. The code under test is the REAL
// app/routes/connect.tsx action + app/lib/image/generate.ts service; only
// `~/lib/db`, IG/Shopify helpers, and @remix-run/react are stubbed. Provider
// HTTP stays on global fetch so tests mock at the HTTP boundary (node:test).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireRoot = createRequire(path.join(ROOT, "package.json"));
const ts = requireRoot("typescript");

// Mutable holder so each test installs a fresh db stub; connect.tsx binds
// `db()` at request time, so rebinding between tests is safe.
export const dbStubHolder = { current: { db: () => { throw new Error("db stub not installed"); } } };

const cache = new Map();

function loadTs(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const filename = path.join(ROOT, rel);
  const src = fs.readFileSync(filename, "utf8");
  const { outputText, diagnostics } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const fatal = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) throw new Error("transpile failed: " + fatal[0].messageText);
  const mod = { exports: {} };
  const localRequire = (spec) => {
    // Indirect through the holder at CALL time: connect.tsx binds db() per
    // request, so each test's fresh stub must be visible (no load-time capture).
    if (spec === "~/lib/db") return { db: (...a) => dbStubHolder.current.db(...a) };
    if (spec === "~/lib/activation/instagram") return { tagInstagram: async () => {} };
    if (spec === "~/lib/shopify/commerce-errors") return { humanizeCommerceError: (s) => s };
    if (spec === "~/lib/image/generate") return loadTs("app/lib/image/generate.ts");
    if (spec === "@remix-run/react") {
      return { Form: "form", useActionData: () => null, useLoaderData: () => null, useNavigation: () => ({ state: "idle" }) };
    }
    return requireRoot(spec);
  };
  new Function("require", "module", "exports", "__filename", "__dirname", outputText)(
    localRequire, mod, mod.exports, filename, path.dirname(filename),
  );
  cache.set(rel, mod.exports);
  return mod.exports;
}

export const loadService = () => loadTs("app/lib/image/generate.ts");
export const loadConnectAction = () => loadTs("app/routes/connect.tsx").action;
export const loadConnectLoader = () => loadTs("app/routes/connect.tsx").loader;

// Fake Neon `sql` tag: answers the exact queries generate/keep issue.
export function makeDb() {
  const state = { shop: "test-shop.myshopify.com", generated: [] };
  const tag = async (strings, ...values) => {
    const q = strings.join("?");
    if (q.includes("FROM shops")) return [{ shop: state.shop, access_token: "tok" }];
    if (q.includes("FROM tag_events")) return [];
    if (q.includes("INSERT INTO generated_images")) {
      // Canonical audit constants interpolated: 8 values.
      const [shop, productId, variantId, style, promptVersion, sourceMode, provider, outputUrl] = values;
      state.generated.push({
        id: state.generated.length + 1, shop, product_id: productId,
        variant_id: variantId, style, prompt_version: promptVersion,
        source_mode: sourceMode, provider, output_url: outputUrl,
      });
      return [];
    }
    if (q.includes("FROM generated_images")) {
      if (q.includes("variant_id")) {
        const [shop, productId, variantId, style, outputUrl] = values;
        return state.generated
          .filter((r) => r.shop === shop && r.product_id === productId && r.variant_id === variantId
            && r.style === style && r.output_url === outputUrl)
          .map((r) => ({ id: r.id }));
      }
      // Loader history: shop-scoped (shop, product_id).
      const [shop, productId] = values;
      return state.generated
        .filter((r) => r.shop === shop && r.product_id === productId)
        .map((r) => ({
          id: r.id, style: r.style, source_mode: r.source_mode,
          output_url: r.output_url, created_at: "2026-11-05 10:00:00",
        }));
    }
    if (q.includes("INSERT INTO tag_events")) return [];
    throw new Error("unexpected query: " + q.slice(0, 80));
  };
  const sql = (s, ...v) => tag(s, ...v);
  return { state, db: () => sql };
}

export function postForm(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://test/connect", { method: "POST", body: fd });
}

// Runs fn with global fetch replaced; asserts the expected call count.
export async function withFetch(responder, fn, { calls: expectedCalls } = {}) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(url, init, calls.length);
  };
  try {
    const out = await fn(calls);
    if (expectedCalls !== undefined) {
      const assert = (await import("node:assert/strict")).default;
      assert.equal(calls.length, expectedCalls, `expected ${expectedCalls} fetch call(s)`);
    }
    return out;
  } finally {
    globalThis.fetch = orig;
  }
}

export const jsonBody = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
