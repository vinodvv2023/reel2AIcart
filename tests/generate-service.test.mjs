import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadService, withFetch, jsonBody } from "./helpers/route-harness.mjs";

// Service under test: app/lib/image/generate.ts (T2, refs #5).
// Expected values come from the spec (issue #1): 6 styles, 5 error codes.
const STYLES = ["flat-lay", "folded-stack", "single-folded", "ghost-mannequin", "hanger", "on-actor"];

const { buildImagePrompt, generateImage, imagesGenerationsUrl } = loadService();

let savedEnv;
beforeEach(() => {
  savedEnv = { key: process.env.MODEL_API_KEY, model: process.env.MUSE_IMAGE_MODEL, base: process.env.META_BASE_URL };
  process.env.MODEL_API_KEY = "test-key";
  delete process.env.MUSE_IMAGE_MODEL;
  delete process.env.META_BASE_URL;
});
afterEach(() => {
  process.env.MODEL_API_KEY = savedEnv.key;
  process.env.MUSE_IMAGE_MODEL = savedEnv.model;
  process.env.META_BASE_URL = savedEnv.base;
});

describe("image service contract", () => {
  it("maps all 6 spec styles to distinct reviewable prompts grounded in the product", () => {
    const prompts = STYLES.map((style) =>
      buildImagePrompt({ title: "Emerald Gown", style }).prompt
    );
    assert.equal(new Set(prompts).size, 6);
    for (const p of prompts) assert.match(p, /Emerald Gown/);
  });

  it("uses with-image mode with a reference photo, text-only without", () => {
    assert.equal(
      buildImagePrompt({ title: "Gown", style: "flat-lay", referenceImageUrl: "https://cdn/x.jpg" }).sourceMode,
      "with-image",
    );
    assert.equal(buildImagePrompt({ title: "Gown", style: "flat-lay" }).sourceMode, "text-only");
    assert.equal(buildImagePrompt({ title: "Gown", style: "flat-lay", referenceImageUrl: "  " }).sourceMode, "text-only");
  });

  it("targets the images generations endpoint", () => {
    assert.match(imagesGenerationsUrl(), /\/images\/generations$/);
  });

  it("returns no-keys without touching the network", async () => {
    delete process.env.MODEL_API_KEY;
    await withFetch(() => { throw new Error("must not fetch"); }, async () => {
      const res = await generateImage({ shop: "s", productId: "1", title: "Gown", style: "flat-lay" });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "no-keys");
    }, { calls: 0 });
  });

  it("maps provider failures to the spec error codes", async () => {
    const cases = [
      [429, "busy", "rate-limit"],
      [400, "content-filter refusal", "content-filter"],
      [500, "boom", "provider-5xx"],
    ];
    for (const [status, body, code] of cases) {
      await withFetch(() => new Response(body, { status }), async () => {
        const res = await generateImage({ shop: "s", productId: "1", title: "Gown", style: "flat-lay" });
        assert.equal(res.ok, false);
        assert.equal(res.error.code, code, `status ${status}`);
      });
    }
  });

  it("maps an abort to timeout", async () => {
    const hanging = (_url, init) => new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    });
    await withFetch(hanging, async () => {
      const res = await generateImage({ shop: "s", productId: "1", title: "Gown", style: "flat-lay", timeoutMs: 30 });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "timeout");
    });
  });

  it("persists exactly one record per success, none per failure", async () => {
    const kept = [];
    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg" }] }), async () => {
      const res = await generateImage({
        shop: "s", productId: "1", variantId: "2", title: "Gown",
        style: "flat-lay", referenceImageUrl: "https://cdn/x.jpg",
        persist: async (r) => { kept.push(r); },
      });
      assert.equal(res.ok, true);
      assert.equal(res.outputUrl, "https://cdn/gen.jpg");
      assert.equal(res.sourceMode, "with-image");
    });
    assert.equal(kept.length, 1);
    assert.deepEqual(
      [kept[0].shop, kept[0].productId, kept[0].variantId, kept[0].style, kept[0].promptVersion, kept[0].sourceMode],
      ["s", "1", "2", "flat-lay", "v1", "with-image"],
    );
  });

  it("never calls persist on failure and survives a persist throw", async () => {
    let persistCalls = 0;
    await withFetch(() => new Response("busy", { status: 429 }), async () => {
      const res = await generateImage({
        shop: "s", productId: "1", title: "Gown", style: "flat-lay",
        persist: async () => { persistCalls++; },
      });
      assert.equal(res.ok, false);
    });
    assert.equal(persistCalls, 0);

    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg" }] }), async () => {
      const res = await generateImage({
        shop: "s", productId: "1", title: "Gown", style: "flat-lay",
        persist: async () => { throw new Error("db down"); },
      });
      assert.equal(res.ok, true);
    });
  });
});
