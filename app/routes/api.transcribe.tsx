import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { transcribeAudio, validateAudio } from "~/lib/voice/transcribe";

// Voice entry: multipart audio -> transcript text. No audio persisted,
// no key leaked. Transcript re-enters the unchanged ?tab=search&q= path.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, { status: 405 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return json({ ok: false, error: "No audio received — try again." }, { status: 400 });
  const err = validateAudio(file.size, file.type);
  if (err) return json({ ok: false, error: err }, { status: 400 });
  try {
    const transcript = await transcribeAudio(Buffer.from(await file.arrayBuffer()), file.type || "audio/webm");
    return json({ ok: true, transcript });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Voice failed — try again.";
    const status = /missing in Vercel env/.test(msg) ? 500 : /rate limit/i.test(msg) ? 429 : /provider failed/i.test(msg) ? 502 : 400;
    return json({ ok: false, error: msg }, { status });
  }
}
