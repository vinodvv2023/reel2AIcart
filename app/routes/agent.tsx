import { json, type ActionFunctionArgs } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { callTool } from "~/lib/mcp/tools";
import { db } from "~/lib/db";

// Web chatbot over the same MCP tools as the CLI demo, via Muse or Grok
// function-calling server-side. Single exchange per submit (no history).
// Needs MODEL_API_KEY and/or XAI_API_KEY (+ GROK_MODEL) in Vercel env.
const PROVIDERS: Record<string, { url: string; keyEnv: string; model: string; reasoning: boolean }> = {
  muse: { url: "https://api.meta.ai/v1/chat/completions", keyEnv: "MODEL_API_KEY", model: "muse-spark-1.3-contributor", reasoning: true },
  grok: { url: "https://api.x.ai/v1/chat/completions", keyEnv: "XAI_API_KEY", model: process.env.GROK_MODEL ?? "", reasoning: false },
};
const TOOLS = [
  { type: "function", function: { name: "search_products",
    description: "Vector-ranked product search over the store's shoppable videos",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "get_video_summary",
    description: "Cached summary JSON for one video",
    parameters: { type: "object", properties: { video_id: { type: "string" } }, required: ["video_id"] } } },
];

type Msg = { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string };

async function complete(messages: Msg[], url: string, key: string, model: string, reasoning: boolean) {
  const body: Record<string, unknown> = { model, messages, tools: TOOLS };
  if (reasoning) body.reasoning_effort = "minimal";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`model API ${res.status}`);
  const m = ((await res.json()) as { choices: { message: Msg & { reasoning_content?: string } }[] }).choices[0].message;
  if (!m.content && m.reasoning_content) m.content = m.reasoning_content;
  return m;
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const provider = String(form.get("provider") ?? "muse");
  const cfg = PROVIDERS[provider];
  if (!cfg) return json({ ok: false as const, error: "Unknown provider." });
  const key = process.env[cfg.keyEnv] ?? "";
  if (!key) return json({ ok: false as const, error: `${cfg.keyEnv} missing in Vercel env.` });
  if (!cfg.model) return json({ ok: false as const, error: "Set GROK_MODEL in Vercel env (current model ID from x.ai console)." });
  const q = String(form.get("q") ?? "").trim().slice(0, 300);
  if (!q) return json({ ok: false as const, error: "Type a question first." });
  let shop = "reel2aicart-test.myshopify.com";
  try {
    const sql = db();
    const rows = (await sql`SELECT shop FROM shops LIMIT 1`) as { shop: string }[];
    if (rows.length) shop = rows[0].shop;
  } catch {
    // fall back to default shop
  }
  const used: string[] = [];
  const messages: Msg[] = [
    { role: "developer", content: "Shopping assistant. Use tools for product questions. Answer with product names and PDP links. Never invent products or prices." },
    { role: "user", content: q },
  ];
  try {
    for (let i = 0; i < 3; i++) {
      const m = await complete(messages, cfg.url, key, cfg.model, cfg.reasoning);
      messages.push({ role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls });
      const calls = (m.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
      if (!calls.length) return json({ ok: true as const, q, provider, answer: m.content ?? "(no answer)", used });
      for (const c of calls) {
        used.push(c.function.name);
        let out: unknown;
        try {
          out = await callTool(shop, c.function.name, JSON.parse(c.function.arguments || "{}"));
        } catch (e) {
          out = { error: e instanceof Error ? e.message : "tool failed" };
        }
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 4000) });
      }
    }
    return json({ ok: true as const, q, provider, answer: "(stopped after 3 tool rounds)", used });
  } catch (e) {
    return json({ ok: false as const, error: e instanceof Error ? e.message : "agent failed" });
  }
}

export default function Agent() {
  const result = useActionData<typeof action>();
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 10, background: "#0f4c4a", position: "relative", flex: "none" }}>
          <span aria-hidden="true" style={{ position: "absolute", left: 12, top: 9, borderLeft: "12px solid #ff7a5c", borderTop: "8px solid transparent", borderBottom: "8px solid transparent" }} />
        </span>
        <strong style={{ fontSize: 22, color: "#0f4c4a" }}>Reel2<span style={{ color: "#ff7a5c" }}>AI</span>Cart assistant</strong>
      </header>
      <p><small>Ask about products in plain words. Powered by Muse, grounded in your store catalog.</small></p>
      <Form method="post" aria-label="Ask the shopping assistant">
        <label htmlFor="provider"><strong>Model</strong></label>{" "}
        <select id="provider" name="provider" style={{ padding: "9px 12px", fontSize: 16, borderRadius: 8, border: "1px solid #e8e2da" }}>
          <option value="muse">Muse Spark</option>
          <option value="grok">Grok</option>
        </select><br /><br />
        <label htmlFor="q"><strong>Your question</strong></label><br />
        <input id="q" name="q" type="search" required maxLength={300} placeholder="e.g. maroon gown" style={{ padding: "9px 12px", fontSize: 16, borderRadius: 8, border: "1px solid #e8e2da", width: "min(420px,100%)" }} />{" "}
        <button type="submit" style={{ borderRadius: 999, padding: "10px 18px", fontWeight: 600, fontSize: 15, cursor: "pointer", background: "#0f4c4a", color: "#fff", border: "1px solid transparent" }}>Ask</button>
      </Form>
      {result && ("error" in result ? (
        <p role="alert" style={{ color: "#b3402a" }}>{result.error}</p>
      ) : (
        <section aria-live="polite" style={{ marginTop: 16, border: "1px solid #e8e2da", borderRadius: 12, padding: 16, background: "#fff" }}>
          <p><strong>You:</strong> {result.q}</p>
          <p><small>Answered by {result.provider === "grok" ? "Grok" : "Muse Spark"}</small></p>
          <p style={{ whiteSpace: "pre-wrap" }}>{result.answer}</p>
          {result.used.length > 0 && <p><small>Tools used: {result.used.join(", ")}</small></p>}
        </section>
      ))}
    </main>
  );
}
