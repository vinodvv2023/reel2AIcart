// Phase-1 loop: POST unknown job_keys with candidate secrets without echoing them.
// Usage: $env:MODAL_INGEST_SECRET="<from Vercel project env, never pasted>" ;
//        node loop-callback2.cjs   (prints only status codes + safe bodies)
(async () => {
  const secret = process.env.MODAL_INGEST_SECRET || "";
  if (!secret) { console.log("NO_SECRET_IN_ENV"); process.exit(2); }
  const res = await fetch("https://reel2-aicart.vercel.app/api/ingest-callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_key: "probe:unknown:" + Date.now(), status: "enriched", detail: "loop-probe", secret }),
  });
  const body = await res.json().catch(() => ({}));
  console.log("http", res.status, JSON.stringify(body));
  console.log(body && body.error === "unknown job_key" ? "VERDICT: auth OK — route works, Modal side never delivers" : "VERDICT: auth FAILED — secret mismatch or route broken");
})().catch((e) => { console.log("LOOP_ERROR:", e.message); process.exit(1); });
