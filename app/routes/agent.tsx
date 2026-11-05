import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { callTool } from "~/lib/mcp/tools";
import { db } from "~/lib/db";

// Agent workspace: Ask (multi-turn, Muse/Grok + history via hidden field)
// and Search (direct vector cards). See docs/AGENT_CHAT.md.
const PROVIDERS: Record<string, { url: string; keyEnv: string; model: string; reasoning: boolean }> = {
  muse: { url: "https://api.meta.ai/v1/chat/completions", keyEnv: "MODEL_API_KEY", model: "muse-spark-1.3-contributor", reasoning: true },
  grok: { url: "https://api.x.ai/v1/chat/completions", keyEnv: "XAI_API_KEY", model: process.env.GROK_MODEL ?? "", reasoning: false },
};

type Msg = { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string };
type Thread = { role: "user" | "assistant"; text: string }[];

async function shopOf(): Promise<string> {
  try {
    const sql = db();
    const rows = (await sql`SELECT shop FROM shops LIMIT 1`) as { shop: string }[];
    if (rows.length) return rows[0].shop;
  } catch {
    // fall back to default shop
  }
  return "reel2aicart-test.myshopify.com";
}

const TOOLS = [
  { type: "function", function: { name: "search_products",
    description: "Vector-ranked product search over the store's shoppable videos",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "get_video_summary",
    description: "Cached summary JSON for one video",
    parameters: { type: "object", properties: { video_id: { type: "string" } }, required: ["video_id"] } } },
];

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

function withUtm(base: string, videoId: string): string {
  try {
    const u = new URL(base);
    u.searchParams.set("utm_source", "agent-chat");
    u.searchParams.set("utm_campaign", videoId);
    return u.toString();
  } catch {
    return base;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  const tab = params.get("tab") === "search" ? "search" : "ask";
  const q = (params.get("q") ?? "").slice(0, 200);
  let results: { id: string; summary: { text_seed?: string; hero_images?: string[] }; pdp_url: string; score: number }[] = [];
  if (tab === "search" && q) {
    const out = (await callTool(await shopOf(), "search_products", { query: q })) as { results: typeof results };
    results = (out.results ?? []).slice(0, 8);
  }
  const shop = params.get("shop") ?? "";
  return json({ tab, q, results, shop });
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
  let hist: Thread = [];
  try {
    hist = JSON.parse(String(form.get("hist") ?? "[]")) as Thread;
    if (!Array.isArray(hist)) hist = [];
  } catch {
    hist = [];
  }
  hist = [...hist.slice(-7), { role: "user", text: q }];
  const shop = await shopOf();
  const used: string[] = [];
  const messages: Msg[] = [
    { role: "developer", content: "Shopping assistant. Use tools for product questions. Answer with product names and PDP links. Never invent products or prices." },
    ...hist.map((h) => ({ role: h.role, content: h.text })),
  ];
  try {
    for (let i = 0; i < 3; i++) {
      const m = await complete(messages, cfg.url, key, cfg.model, cfg.reasoning);
      messages.push({ role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls });
      const calls = (m.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
      if (!calls.length) {
        const answer = m.content ?? "(no answer)";
        return json({ ok: true as const, q, provider, answer, used, hist: [...hist, { role: "assistant", text: answer }] });
      }
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
    return json({ ok: true as const, q, provider, answer: "(stopped after 3 tool rounds)", used, hist });
  } catch (e) {
    return json({ ok: false as const, error: e instanceof Error ? e.message : "agent failed" });
  }
}

const inputStyle = { padding: "9px 12px", fontSize: 16, borderRadius: 8, border: "1px solid #e8e2da", color: "#141413", background: "#fff" } as const;

export default function Agent() {
  const { tab, q: sq, results, shop } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const thread: Thread = result && "hist" in result ? (result.hist as Thread) : [];
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 860, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 10, background: "#0f4c4a", position: "relative", flex: "none" }}>
          <span aria-hidden="true" style={{ position: "absolute", left: 12, top: 9, borderLeft: "12px solid #ff7a5c", borderTop: "8px solid transparent", borderBottom: "8px solid transparent" }} />
        </span>
        <strong style={{ fontSize: 22, color: "#0f4c4a" }}>Reel2<span style={{ color: "#ff7a5c" }}>AI</span>Cart assistant</strong>
      </header>
      <p style={{ marginTop: 12 }}>
        <a href={shop && shop !== "unknown shop" ? `/?shop=${encodeURIComponent(shop)}` : "/"} style={{ borderRadius: 999, padding: "8px 16px", fontWeight: 600, textDecoration: "none", background: "#fff", color: "#0f4c4a", border: "1px solid #0f4c4a" }}>Back to dashboard</a>
      </p>
      <nav aria-label="Agent modes" style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <a href="/agent?tab=ask" style={{ borderRadius: 999, padding: "8px 16px", fontWeight: 600, textDecoration: "none", background: tab === "ask" ? "#0f4c4a" : "#fff", color: tab === "ask" ? "#fff" : "#0f4c4a", border: "1px solid #0f4c4a" }}>Ask</a>
        <a href="/agent?tab=search" style={{ borderRadius: 999, padding: "8px 16px", fontWeight: 600, textDecoration: "none", background: tab === "search" ? "#0f4c4a" : "#fff", color: tab === "search" ? "#fff" : "#0f4c4a", border: "1px solid #0f4c4a" }}>Search</a>
      </nav>

      {tab === "search" ? (
        <section aria-label="Catalog search" style={{ marginTop: 16 }}>
          <Form method="get" aria-label="Search the catalog">
            <input type="hidden" name="tab" value="search" />
            <label htmlFor="sq"><strong>Search products</strong></label><br />
            <input id="sq" name="q" type="search" data-voice-input="" defaultValue={sq} placeholder="e.g. ballerina" style={{ ...inputStyle, width: "min(420px,100%)" }} />{" "}
            <button type="submit" style={{ borderRadius: 999, padding: "10px 18px", fontWeight: 600, fontSize: 15, cursor: "pointer", background: "#0f4c4a", color: "#fff", border: "1px solid transparent" }}>Search</button>
          </Form>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", marginTop: 16 }}>
            {results.map((r, i) => (
              <article key={r.id} style={{ border: "1px solid #e8e2da", borderRadius: 12, padding: 12, background: i % 2 ? "#eef6f5" : "#fdf3ec" }}>
                {r.summary.hero_images?.[0] ? (
                  <img src={r.summary.hero_images[0]} alt="" loading="lazy" style={{ width: "100%", height: 140, objectFit: "cover", borderRadius: 8 }} />
                ) : (
                  <div aria-hidden="true" style={{ width: "100%", height: 140, borderRadius: 8, background: "#f3ddd2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, fontWeight: 700, color: "#0f4c4a" }}>
                    {(r.summary.text_seed ?? "R").charAt(0).toUpperCase()}
                  </div>
                )}
                <p><small>{(r.summary.text_seed ?? "").slice(0, 120)}</small></p>
                <p><small>score {r.score.toFixed(2)}</small> · <a href={withUtm(r.pdp_url, r.id)}>View product</a></p>
              </article>
            ))}
          </div>
          {sq && results.length === 0 && <p><small>No matches.</small></p>}
        </section>
      ) : (
        <section aria-label="Chat" style={{ marginTop: 16 }}>
          {thread.length > 0 && (
            <div aria-live="polite" style={{ display: "grid", gap: 10, marginBottom: 16 }}>
              {thread.map((m, i) => (
                <div key={i} style={{ border: "1px solid #e8e2da", borderRadius: 12, padding: 12, background: m.role === "user" ? "#eef6f5" : "#fff" }}>
                  <p><strong>{m.role === "user" ? "You" : "Assistant"}:</strong></p>
                  <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{m.text}</p>
                </div>
              ))}
            </div>
          )}
          <Form method="post" aria-label="Ask the shopping assistant">
            <input type="hidden" name="hist" value={JSON.stringify(thread)} />
            <label htmlFor="provider"><strong>Agent</strong></label>{" "}
            <select id="provider" name="provider" style={inputStyle}>
              <option value="muse">Muse Spark</option>
              <option value="grok">Grok</option>
            </select><br /><br />
            <label htmlFor="q"><strong>Your question</strong></label><br />
            <input id="q" name="q" type="search" data-voice-input="" required maxLength={300} placeholder="e.g. maroon gown" style={{ ...inputStyle, width: "min(420px,100%)" }} />{" "}
            <button type="submit" style={{ borderRadius: 999, padding: "10px 18px", fontWeight: 600, fontSize: 15, cursor: "pointer", background: "#0f4c4a", color: "#fff", border: "1px solid transparent" }}>Ask</button>
          </Form>
          {result && ("error" in result ? (
            <p role="alert" style={{ color: "#b3402a" }}>{result.error}</p>
          ) : (
            result.used.length > 0 && <p><small>Answered by {result.provider === "grok" ? "Grok" : "Muse Spark"} · tools: {result.used.join(", ")}</small></p>
          ))}
        </section>
      )}
      <script src="/voice-mic.js" defer />
    </main>
  );
}
