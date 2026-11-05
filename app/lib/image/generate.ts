// Image-generation service. Single server seam for connect.
// Contract: https://dev.meta.ai/docs/image-generation (Muse Image 1.0,
// single-shot OpenAI-compatible endpoints at {META_BASE_URL}):
// - POST /v1/images/generations {model, prompt, n} — text-to-image.
// - POST /v1/images/edits {model, prompt, images:[{image_url}], n} —
//   image-to-image; reference = public URL or data URL (Meta JSON shape).
// Both return {data:[{b64_json}] | [{url}] with response_format:"url",
// output_format, usage}. Default response_format is b64_json.
// T3 note: if Remix/Vercel action limits bite (gen takes 30-120s+), switch this
// synchronous-but-bounded call to a job row (queued->done/failed) + GET-poll render.
export type ImageStyle =
  | "flat-lay" | "folded-stack" | "single-folded"
  | "ghost-mannequin" | "hanger" | "on-actor";
export type SourceMode = "with-image" | "text-only";
export type ImageErrorCode =
  | "no-keys" | "rate-limit" | "content-filter" | "provider-4xx" | "provider-5xx" | "timeout";
export const PROMPT_VERSION = "v1";
export const IMAGE_PROVIDER = "muse-image-1.0";
const STYLE_SCENES: Record<ImageStyle, string> = {
  "flat-lay": "clean top-down flat-lay on a seamless light backdrop, garment fully spread, no people",
  "folded-stack": "neat stack of multiple folded units, top-down three-quarter view, no people",
  "single-folded": "one crisply folded unit centered on a seamless backdrop, e-commerce thumbnail, no people",
  "ghost-mannequin": "invisible-mannequin apparel shot showing fit and drape, no visible model or mannequin parts",
  hanger: "garment on a simple hanger against a seamless backdrop, category-grid shot, no people",
  "on-actor": "worn-by-model lifestyle shot, neutral pose and backdrop, face out of focus",
};
export function buildImagePrompt(input: {
  title: string; variantTitle?: string; referenceImageUrl?: string; style: ImageStyle;
}): { prompt: string; sourceMode: SourceMode } {
  const scene = STYLE_SCENES[input.style];
  if (!scene) throw new Error(`unknown style: ${String(input.style)}`);
  const variant = input.variantTitle?.trim() ? `, variant ${input.variantTitle.trim()}` : "";
  const ref = input.referenceImageUrl?.trim()
    ? ` Match the color, print, and details of the reference product photo.`
    : ` No reference photo available; interpret freely from the product name.`;
  return {
    prompt: `Product photo of ${input.title.trim()}${variant}: ${scene}.${ref}`,
    sourceMode: input.referenceImageUrl?.trim() ? "with-image" : "text-only",
  };
}
// Adapters: single place encoding the endpoint paths (see contract above).
function metaBase(): string {
  return (process.env.META_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
}
export function imagesGenerationsUrl(): string {
  return `${metaBase()}/images/generations`;
}
export function imagesEditsUrl(): string {
  return `${metaBase()}/images/edits`;
}
export type ImageEndpoint = "generations" | "edits";
// Pure request builder (test seam): reference image goes on the EDITS
// endpoint (images array); text-only goes on GENERATIONS. Auth header is
// added by generateImage and never part of the displayable payload.
export function buildImageRequest(input: {
  title: string; variantTitle?: string; referenceImageUrl?: string; style: ImageStyle;
}): {
  url: string; endpoint: ImageEndpoint; model: string; body: Record<string, unknown>;
  prompt: string; sourceMode: SourceMode; referenceAttached: boolean;
} {
  const { prompt, sourceMode } = buildImagePrompt(input);
  const model = process.env.MUSE_IMAGE_MODEL ?? IMAGE_PROVIDER;
  const referenceImageUrl = input.referenceImageUrl?.trim() ?? "";
  if (referenceImageUrl) {
    return {
      url: imagesEditsUrl(), endpoint: "edits", model, prompt, sourceMode,
      referenceAttached: true,
      body: { model, prompt, images: [{ image_url: referenceImageUrl }], n: 1 },
    };
  }
  return {
    url: imagesGenerationsUrl(), endpoint: "generations", model, prompt, sourceMode,
    referenceAttached: false,
    body: { model, prompt, n: 1 },
  };
}
export type GeneratedImageRecord = {
  shop: string; productId: string; variantId: string; style: ImageStyle;
  promptVersion: string; sourceMode: SourceMode; provider: string; outputUrl: string;
};
export type GenerateSuccess = {
  ok: true; outputUrl: string; sourceMode: SourceMode; prompt: string;
  endpoint: ImageEndpoint; model: string; referenceAttached: boolean;
  requestBody: Record<string, unknown>;
};
export type GenerateFailure = { ok: false; error: { code: ImageErrorCode; message: string } };
export async function generateImage(input: {
  shop: string; productId: string; variantId?: string; title: string;
  variantTitle?: string; referenceImageUrl?: string; style: ImageStyle; timeoutMs?: number;
  persist?: (r: GeneratedImageRecord) => Promise<unknown>;
}): Promise<GenerateSuccess | GenerateFailure> {
  const key = process.env.MODEL_API_KEY ?? "";
  if (!key) return { ok: false, error: { code: "no-keys", message: "MODEL_API_KEY missing in Vercel env - add it to enable image generation." } };
  const req = buildImageRequest(input);
  const timeoutMs = input.timeoutMs ?? 60000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    if (res.status === 429)
      return { ok: false, error: { code: "rate-limit", message: "Image provider rate limit hit; try again shortly." } };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (/content[\s_-]?filter|moderation|safety|blocked/i.test(body))
        return { ok: false, error: { code: "content-filter", message: "Provider refused the image request (content filter) - try a different photo or style." } };
      if (res.status >= 400 && res.status < 500)
        return { ok: false, error: { code: "provider-4xx", message: `Image request rejected by the provider (status ${res.status}) - check the product details and try again.` } };
      return { ok: false, error: { code: "provider-5xx", message: `Image provider error (status ${res.status}) - try again shortly.` } };
    }
    const json = (await res.json()) as {
      data?: ({ url?: string; b64_json?: string })[]; output_format?: string;
    };
    const item = json.data?.[0];
    const format = (json.output_format ?? "webp").replace(/[^a-z]/gi, "") || "webp";
    // Default response_format is b64_json: raw bytes are NOT an <img> src —
    // wrap as a data URI. The url form (opt-in response_format) passes through.
    const outputUrl = item?.url ?? (item?.b64_json ? `data:image/${format};base64,${item.b64_json}` : "");
    if (!outputUrl) return { ok: false, error: { code: "provider-5xx", message: "Image provider returned no image." } };
    try {
      await input.persist?.({
        shop: input.shop, productId: input.productId, variantId: input.variantId ?? "",
        style: input.style, promptVersion: PROMPT_VERSION, sourceMode: req.sourceMode,
        provider: IMAGE_PROVIDER, outputUrl,
      });
    } catch { /* logging never breaks the response (connect convention) */ }
    return {
      ok: true, outputUrl, sourceMode: req.sourceMode, prompt: req.prompt,
      endpoint: req.endpoint, model: req.model, referenceAttached: req.referenceAttached,
      requestBody: req.body,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError" || (e as Error)?.name === "AbortError")
      return { ok: false, error: { code: "timeout", message: `Image request timed out after ${timeoutMs}ms.` } };
    return { ok: false, error: { code: "provider-5xx", message: "Image provider unreachable." } };
  } finally {
    clearTimeout(timer);
  }
}
