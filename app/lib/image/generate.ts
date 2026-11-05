// Image-generation service (T2, refs #5). Single server seam for connect.
// NOTE (unconfirmed API): Muse Image 1.0 docs could not be verified; the call below
// targets the probable OpenAI-style `POST {META_BASE_URL}/images/generations` shape.
// If the probe differs, fix it in ONE place: imagesGenerationsUrl()/request body.
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
// Adapter: single place encoding the assumed endpoint path (see NOTE above).
export function imagesGenerationsUrl(): string {
  return `${(process.env.META_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "")}/images/generations`;
}
export type GeneratedImageRecord = {
  shop: string; productId: string; variantId: string; style: ImageStyle;
  promptVersion: string; sourceMode: SourceMode; provider: string; outputUrl: string;
};
export type GenerateSuccess = { ok: true; outputUrl: string; sourceMode: SourceMode };
export type GenerateFailure = { ok: false; error: { code: ImageErrorCode; message: string } };
export async function generateImage(input: {
  shop: string; productId: string; variantId?: string; title: string;
  variantTitle?: string; referenceImageUrl?: string; style: ImageStyle; timeoutMs?: number;
  persist?: (r: GeneratedImageRecord) => Promise<unknown>;
}): Promise<GenerateSuccess | GenerateFailure> {
  const key = process.env.MODEL_API_KEY ?? "";
  if (!key) return { ok: false, error: { code: "no-keys", message: "MODEL_API_KEY missing in Vercel env - add it to enable image generation." } };
  const { prompt, sourceMode } = buildImagePrompt(input);
  const timeoutMs = input.timeoutMs ?? 60000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imagesGenerationsUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.MUSE_IMAGE_MODEL ?? IMAGE_PROVIDER, prompt, n: 1 }),
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
    const json = (await res.json()) as { data?: ({ url?: string; b64_json?: string })[]; images?: string[] };
    const outputUrl = json.data?.[0]?.url ?? json.data?.[0]?.b64_json ?? json.images?.[0] ?? "";
    if (!outputUrl) return { ok: false, error: { code: "provider-5xx", message: "Image provider returned no image." } };
    try {
      await input.persist?.({
        shop: input.shop, productId: input.productId, variantId: input.variantId ?? "",
        style: input.style, promptVersion: PROMPT_VERSION, sourceMode,
        provider: IMAGE_PROVIDER, outputUrl,
      });
    } catch { /* logging never breaks the response (connect convention) */ }
    return { ok: true, outputUrl, sourceMode };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError" || (e as Error)?.name === "AbortError")
      return { ok: false, error: { code: "timeout", message: `Image request timed out after ${timeoutMs}ms.` } };
    return { ok: false, error: { code: "provider-5xx", message: "Image provider unreachable." } };
  } finally {
    clearTimeout(timer);
  }
}
