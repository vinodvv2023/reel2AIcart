// Progressive voice enhancement: mic button beside [data-voice-input].
// No mic -> no button, typed search unchanged. Transcript fills input
// for user confirm; never auto-submits.
(function () {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
  document.querySelectorAll("input[data-voice-input]").forEach((input) => {
    if (input.dataset.voiceReady) return;
    input.dataset.voiceReady = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🎤 Voice";
    btn.className = "btn btn-ghost";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "Dictate search query");
    const status = document.createElement("p");
    status.setAttribute("aria-live", "polite");
    status.style.margin = "4px 0 0";
    input.after(status);
    input.after(btn, " ");
    let rec = null, chunks = [], timer = 0;
    const setStatus = (t) => { status.innerHTML = t ? "<small>" + t + "</small>" : ""; };
    btn.onclick = async () => {
      if (rec) { rec.stop(); return; }
      setStatus("");
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setStatus("Mic blocked — allow access or keep typing.");
        return;
      }
      chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const started = Date.now();
      timer = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        btn.textContent = "⏹ Stop (" + s + "s)";
        if (s >= 30 && rec) rec.stop();
      }, 500);
      btn.setAttribute("aria-pressed", "true");
      btn.textContent = "⏹ Stop (0s)";
      setStatus("Listening… tap Stop when done.");
      rec.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        const cur = rec; rec = null;
        btn.setAttribute("aria-pressed", "false");
        btn.textContent = "🎤 Voice";
        const blob = new Blob(chunks, { type: cur.mimeType || "audio/webm" });
        if (!blob.size) { setStatus("We didn't hear anything — try again."); return; }
        setStatus("Transcribing…");
        btn.disabled = true;
        try {
          const fd = new FormData();
          fd.append("audio", blob, "clip");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.transcript) throw new Error(body.error || "Voice failed.");
          input.value = String(body.transcript).slice(0, 300);
          input.focus();
          setStatus("Heard: “" + input.value.slice(0, 80) + "” — edit then submit.");
        } catch (e) {
          setStatus((e && e.message) || "Voice failed — keep typing.");
        } finally {
          btn.disabled = false;
        }
      };
      rec.start();
    };
  });
})();
