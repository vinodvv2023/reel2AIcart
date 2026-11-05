import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadService, withFetch, jsonBody } from "./helpers/route-harness.mjs";

// Service under test: app/lib/image/generate.ts (T2, refs #5).
// Expected values come from the spec (issue #1): 6 styles, 5 error codes.
const STYLES = ["flat-lay", "folded-stack", "single-stack", "ghost-mannequin", "hanger", "on-actor"];

const { buildImagePrompt, buildImageRequest, generateImage, imagesGenerationsUrl, imagesEditsUrl, PROMPT_VERSION, IMAGE_PROVIDER } = loadService();

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

  it("folded-stack demands multiple units, single-stack exactly one", () => {
    const stack = buildImagePrompt({ title: "Gown", style: "folded-stack" }).prompt;
    assert.match(stack, /more than one folded item/);
    const single = buildImagePrompt({ title: "Gown", style: "single-stack" }).prompt;
    assert.match(single, /one item only/);
  });

  it("on-actor drops the face clause and demands a fresh pose off the reference", () => {
    const withRef = buildImagePrompt({ title: "Gown", style: "on-actor", referenceImageUrl: "https://cdn/x.jpg" }).prompt;
    assert.doesNotMatch(withRef, /face out of focus/);
    assert.match(withRef, /different from the reference/);
    const textOnly = buildImagePrompt({ title: "Gown", style: "on-actor" }).prompt;
    assert.doesNotMatch(textOnly, /face out of focus/);
    assert.doesNotMatch(textOnly, /different from the reference/);
  });

  it("flat-lay defaults to wrinkle-free, opt-out shows natural wrinkles", () => {
    assert.match(
      buildImagePrompt({ title: "Gown", style: "flat-lay" }).prompt,
      /wrinkle-free/,
    );
    const off = buildImagePrompt({ title: "Gown", style: "flat-lay", wrinkleFree: false }).prompt;
    assert.doesNotMatch(off, /wrinkle-free/);
    assert.match(off, /natural fabric.*slight wrinkles/i);
  });

  it("wrinkleFree is ignored outside flat-lay", () => {
    const p = buildImagePrompt({ title: "Gown", style: "ghost-mannequin", wrinkleFree: false }).prompt;
    assert.doesNotMatch(p, /wrinkle|pressed/i);
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
    assert.match(imagesEditsUrl(), /\/images\/edits$/);
  });

  it("routes a reference photo to edits with images[], text-only to generations", () => {
    const withRef = buildImageRequest({ title: "Gown", style: "flat-lay", referenceImageUrl: "https://cdn/x.jpg" });
    assert.equal(withRef.endpoint, "edits");
    assert.equal(withRef.url, imagesEditsUrl());
    assert.equal(withRef.referenceAttached, true);
    assert.deepEqual(withRef.body.images, [{ image_url: "https://cdn/x.jpg" }]);
    const textOnly = buildImageRequest({ title: "Gown", style: "flat-lay" });
    assert.equal(textOnly.endpoint, "generations");
    assert.equal(textOnly.url, imagesGenerationsUrl());
    assert.equal(textOnly.referenceAttached, false);
    assert.ok(!("images" in textOnly.body));
  });

  it("returns no-keys without touching the network", async () => {
    delete process.env.MODEL_API_KEY;
    await withFetch(() => { throw new Error("must not fetch"); }, async () => {
      const res = await generateImage({ shop: "s", productId: "1", title: "Gown", style: "flat-lay" });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "no-keys");
    }, { calls: 0 });
  });

  it("condenses OpenAI-style provider errors to one evidence line", () => {
    const { providerErrorDetail } = loadService();
    assert.equal(
      providerErrorDetail(JSON.stringify({ error: { type: "invalid_request_error", message: "images[0] bad", param: "images[0].image_url", code: "invalid_image" } })),
      "invalid_request_error | code=invalid_image | param=images[0].image_url | images[0] bad",
    );
    assert.equal(providerErrorDetail("  plain   failure\ntext  "), "plain failure text");
    assert.equal(providerErrorDetail(""), "");
    assert.equal(providerErrorDetail("x".repeat(600)).length, 500);
  });

  it("maps provider failures to the spec error codes", async () => {
    const cases = [
      [429, "busy", "rate-limit"],
      [400, "content-filter refusal", "content-filter"],
      [400, "rejected by content filter policy", "content-filter"],
      [400, "bad request", "provider-4xx"],
      [422, "invalid params", "provider-4xx"],
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
    assert.equal(PROMPT_VERSION, "v1");
    assert.equal(IMAGE_PROVIDER, "muse-image-1.0");
    assert.equal(kept[0].provider, IMAGE_PROVIDER);
  });

  it("wraps b64_json as a data URI using the echoed output format", async () => {
    await withFetch(() => jsonBody({ data: [{ b64_json: "QUJD" }], output_format: "png" }), async () => {
      const res = await generateImage({ shop: "s", productId: "1", title: "Gown", style: "flat-lay" });
      assert.equal(res.ok, true);
      assert.equal(res.outputUrl, "data:image/png;base64,QUJD");
    });
  });

  it("prefers the url field when the provider returns one", async () => {
    await withFetch(() => jsonBody({ data: [{ url: "https://cdn/gen.jpg", b64_json: "QUJD" }] }), async () => {
      const res = await generateImage({ shop: "s", productId: "1", title: "Gown", style: "flat-lay" });
      assert.equal(res.ok, true);
      assert.equal(res.outputUrl, "https://cdn/gen.jpg");
    });
  });

  it("success carries prompt, endpoint, model and request body for display", async () => {
    let sent;
    await withFetch((url, init) => {
      sent = JSON.parse(init.body);
      return jsonBody({ data: [{ b64_json: "QUJD" }] });
    }, async (calls) => {
      const res = await generateImage({
        shop: "s", productId: "1", title: "Emerald Gown", variantTitle: "M",
        style: "flat-lay", referenceImageUrl: "https://cdn/x.jpg",
      });
      assert.equal(res.ok, true);
      assert.match(res.prompt, /Emerald Gown/);
      assert.equal(res.endpoint, "edits");
      assert.equal(res.model, "muse-image-1.0");
      assert.equal(res.referenceAttached, true);
      assert.deepEqual(res.requestBody, sent);
      assert.ok(String(calls[0].url).endsWith("/images/edits"));
    }, { calls: 1 });
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
