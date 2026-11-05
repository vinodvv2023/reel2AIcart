import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadConnectAction, loadConnectLoader, loadService, dbStubHolder, makeDb, postForm, withFetch, jsonBody,
} from "./helpers/route-harness.mjs";

// Route under test: the REAL app/routes/connect.tsx action (T3/T6, refs #3/#7).
// Provider mocked at the HTTP boundary (global fetch); Neon mocked via the
// ~/lib/db stub. Picks-intact = every path returns json, never a redirect.
const action = loadConnectAction();

const GEN = {
  intent: "generate", productId: "42", variantId: "7", style: "flat-lay",
  productTitle: "Emerald Gown", variantTitle: "M", referenceImageUrl: "https://cdn/x.jpg",
};

let savedKey;
beforeEach(() => {
  savedKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "test-key";
  dbStubHolder.current = makeDb();
});
afterEach(() => { process.env.MODEL_API_KEY = savedKey; });

async function act(fields) {
  const res = await action({ request: postForm(fields), params: {}, context: {} });
  return { status: res.status, body: await res.json() };
}

describe("connect generate intent", () => {
  it("valid product+style returns a preview after exactly one provider call", async () => {
    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg" }] }), async () => {
      const { status, body } = await act(GEN);
      assert.equal(status, 200);
      assert.equal(body.intent, "generate");
      assert.equal(body.ok, true);
      assert.equal(body.outputUrl, "https://cdn/gen.jpg");
      assert.equal(body.sourceMode, "with-image");
    }, { calls: 1 });
  });

  it("generate with a reference photo posts to edits with images[] and returns display fields", async () => {
    await withFetch(() => jsonBody({ data: [{ b64_json: "QUJD" }] }), async (calls) => {
      const { status, body } = await act(GEN);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.ok(String(calls[0].url).endsWith("/images/edits"));
      assert.deepEqual(JSON.parse(calls[0].init.body).images, [{ image_url: "https://cdn/x.jpg" }]);
      assert.equal(body.outputUrl, "data:image/webp;base64,QUJD");
      assert.match(body.prompt, /Emerald Gown/);
      assert.equal(body.endpoint, "edits");
      assert.equal(body.referenceAttached, true);
      assert.equal(typeof body.requestBody, "object");
    }, { calls: 1 });
  });

  it("generate without a reference posts to generations with no images field", async () => {
    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg" }] }), async (calls) => {
      const { status, body } = await act({ ...GEN, referenceImageUrl: "" });
      assert.equal(status, 200);
      assert.equal(body.sourceMode, "text-only");
      assert.ok(String(calls[0].url).endsWith("/images/generations"));
      assert.ok(!("images" in JSON.parse(calls[0].init.body)));
    }, { calls: 1 });
  });

  it("missing product is a readable 400 with picks intact (json, no redirect)", async () => {
    const { status, body } = await act({ ...GEN, productId: "" });
    assert.equal(status, 400);
    assert.equal(body.intent, "generate");
    assert.match(body.error, /Pick a product/);
  });

  it("unknown style is a readable 400 naming the 6-style picker", async () => {
    const { status, body } = await act({ ...GEN, style: "noir" });
    assert.equal(status, 400);
    assert.match(body.error, /6 styles/);
  });

  it("provider rate-limit surfaces the exact cause with picks intact", async () => {
    await withFetch(() => new Response("busy", { status: 429 }), async () => {
      const { status, body } = await act(GEN);
      assert.equal(status, 429);
      assert.equal(body.intent, "generate");
      assert.match(body.error, /rate limit/i);
    });
  });

  it("provider 5xx surfaces as 502 with picks intact", async () => {
    await withFetch(() => new Response("boom", { status: 500 }), async () => {
      const { status, body } = await act(GEN);
      assert.equal(status, 502);
      assert.match(body.error, /provider/i);
    });
  });

  it("provider 4xx surfaces as 400, not 502", async () => {
    await withFetch(() => new Response("bad request", { status: 400 }), async () => {
      const { status, body } = await act(GEN);
      assert.equal(status, 400);
      assert.match(body.error, /rejected by the provider/i);
    });
  });

  it("spaced 'content filter' wording classifies as content-filter", async () => {
    await withFetch(() => new Response("rejected by content filter policy", { status: 400 }), async () => {
      const { status, body } = await act(GEN);
      assert.equal(status, 502);
      assert.match(body.error, /content filter/i);
    });
  });

  it("missing keys surfaces as 500 without touching the network", async () => {
    delete process.env.MODEL_API_KEY;
    await withFetch(() => { throw new Error("must not fetch"); }, async () => {
      const { status, body } = await act(GEN);
      assert.equal(status, 500);
      assert.match(body.error, /MODEL_API_KEY/);
    }, { calls: 0 });
  });
});

describe("connect keep intent", () => {
  const KEEP = {
    intent: "keep", productId: "42", variantId: "7", style: "flat-lay",
    outputUrl: "https://cdn/gen.jpg", sourceMode: "with-image",
  };

  it("generate-then-keep persists exactly one record per accept", async () => {
    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg" }] }), async () => {
      const preview = await act(GEN);
      assert.equal(preview.body.ok, true);
      const first = await act(KEEP);
      assert.equal(first.body.ok, true);
      assert.equal(first.body.duplicate, false);
      const second = await act(KEEP);
      assert.equal(second.body.ok, true);
      assert.equal(second.body.duplicate, true);
      assert.equal(dbStubHolder.current.state.generated.length, 1);
    });
  });

  it("keep with nothing generated is a readable 400", async () => {
    const { status, body } = await act({ ...KEEP, outputUrl: "" });
    assert.equal(status, 400);
    assert.match(body.error, /Nothing to keep/);
  });

  const DATA_URI = "data:image/png;base64," + "QUJD".repeat(100);

  it("keep stores a provider data URI as-is and dedupes the re-keep", async () => {
    const first = await act({ ...KEEP, outputUrl: DATA_URI });
    assert.equal(first.body.ok, true);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.outputUrl, DATA_URI);
    const second = await act({ ...KEEP, outputUrl: DATA_URI });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.duplicate, true);
    assert.equal(dbStubHolder.current.state.generated.length, 1);
  });

  it("keep rejects non-image data URIs and oversized payloads", async () => {
    const bad = await act({ ...KEEP, outputUrl: "data:text/plain;base64,QUJD" });
    assert.equal(bad.status, 400);
    const big = await act({ ...KEEP, outputUrl: "data:image/png;base64," + "A".repeat(4_500_001) });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /too large/i);
  });

  it("keep with a bad source mode is a readable 400", async () => {
    const { status, body } = await act({ ...KEEP, sourceMode: "vibes" });
    assert.equal(status, 400);
    assert.match(body.error, /invalid/i);
  });

  it("keep survives a db outage with a 500, never throwing to UI", async () => {
    dbStubHolder.current = { state: { generated: [] }, db: () => { throw new Error("db down"); } };
    const { status, body } = await act(KEEP);
    assert.equal(status, 500);
    assert.match(body.error, /Could not save/);
  });

  it("keep audit row uses the canonical prompt-version and provider constants", async () => {
    const { PROMPT_VERSION, IMAGE_PROVIDER } = loadService();
    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg" }] }), async () => {
      const kept = await act(KEEP);
      assert.equal(kept.body.ok, true);
      const [row] = dbStubHolder.current.state.generated;
      assert.equal(row.prompt_version, PROMPT_VERSION);
      assert.equal(row.provider, IMAGE_PROVIDER);
    });
  });
});

describe("connect export intent", () => {
  const EXPORT = {
    intent: "export", productId: "42", style: "flat-lay",
    productTitle: "Emerald Gown", confirm: "yes",
    outputUrl: "data:image/png;base64," + "QUJD".repeat(100),
  };

  it("export uploads kept bytes to Files and upgrades the stored row", async () => {
    const kept = await act({
      intent: "keep", productId: "42", variantId: "7", style: "flat-lay",
      outputUrl: EXPORT.outputUrl, sourceMode: "with-image",
    });
    assert.equal(kept.body.ok, true);
    const staged = { data: { stagedUploadsCreate: { stagedTargets: [{ url: "https://up/x", resourceUrl: "https://files/y", parameters: [] }], userErrors: [] } } };
    const created = { data: { fileCreate: { files: [{ url: "https://shop.cdn/files/kept.png" }], userErrors: [] } } };
    await withFetch((url, init) => {
      const u = String(url);
      if (u.includes("/graphql.json") && String(init.body).includes("stagedUploadsCreate")) return jsonBody(staged);
      if (u === "https://up/x") return new Response("ok", { status: 200 });
      if (u.includes("/graphql.json")) return jsonBody(created);
      throw new Error("unexpected fetch: " + u);
    }, async () => {
      const { status, body } = await act(EXPORT);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.filesUrl, "https://shop.cdn/files/kept.png");
      const [row] = dbStubHolder.current.state.generated;
      assert.equal(row.output_url, "https://shop.cdn/files/kept.png");
    }, { calls: 3 });
  });

  it("export without confirmation is a readable 400", async () => {
    const { status, body } = await act({ ...EXPORT, confirm: "" });
    assert.equal(status, 400);
    assert.match(body.error, /confirmation/i);
  });
});

describe("connect loader history", () => {
  const loader = loadConnectLoader();
  const shopFetch = (url) => {
    if (String(url).includes("graph.facebook.com")) return jsonBody({ data: [] });
    if (String(url).includes("/admin/api/")) return jsonBody({ products: [] });
    throw new Error("unexpected fetch: " + url);
  };

  it("history is scoped to the current shop", async () => {
    dbStubHolder.current = makeDb();
    dbStubHolder.current.state.shop = "shop-a.myshopify.com";
    dbStubHolder.current.state.generated.push(
      { id: 1, shop: "shop-a.myshopify.com", product_id: "42", variant_id: "7", style: "flat-lay", prompt_version: "v1", source_mode: "with-image", provider: "muse-image-1.0", output_url: "https://cdn/a.jpg" },
      { id: 2, shop: "shop-b.myshopify.com", product_id: "42", variant_id: "7", style: "flat-lay", prompt_version: "v1", source_mode: "with-image", provider: "muse-image-1.0", output_url: "https://cdn/b.jpg" },
    );
    await withFetch(shopFetch, async () => {
      const res = await loader({ request: new Request("http://test/connect?product=42"), params: {}, context: {} });
      const body = await res.json();
      assert.equal(body.genHistory.length, 1);
      assert.equal(body.genHistory[0].outputUrl, "https://cdn/a.jpg");
    });
  });
});
