// Server-side Muse Voice Transcribe helper. Audio is transcribed and
// discarded — never persisted. Thin contract for route + unit seams.
export const MAX_AUDIO_BYTES = 4_000_000;
export const ALLOWED_AUDIO = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/x-wav",
]);

export function voiceConfig() {
  const key = process.env.MODEL_API_KEY ?? "";
  const model = process.env.VOICE_MODEL ?? "muse-spark-voice-1";
  const url = process.env.VOICE_URL ?? "https://api.meta.ai/v1/audio/transcriptions";
  return { key, model, url };
}

export function validateAudio(size: number, type: string): string | null {
  if (!size) return "We didn't hear anything — try again.";
  if (size > MAX_AUDIO_BYTES) return "Clip too long — keep it under 30 seconds.";
  const base = type.split(";")[0].trim().toLowerCase();
  if (base && !ALLOWED_AUDIO.has(base)) return "Unsupported audio format — try again.";
  return null;
}

function mapStatus(status: number): string {
  if (status === 429) return "Voice is busy (rate limit) — try again.";
  if (status >= 500) return "Voice provider failed — try again.";
  return "Voice rejected the clip — try again.";
}

export async function transcribeAudio(buf: Buffer, contentType: string): Promise<string> {
  const { key, model, url } = voiceConfig();
  if (!key) throw new Error("MODEL_API_KEY missing in Vercel env.");
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([new Uint8Array(buf)], { type: contentType }), "clip");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(mapStatus(res.status));
  const body = (await res.json().catch(() => ({}))) as { text?: string };
  const text = String(body.text ?? "").trim().slice(0, 300);
  if (!text) throw new Error("We didn't hear anything — try again.");
  return text;
}
