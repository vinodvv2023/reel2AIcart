# Manual /connect pass (T7, refs #8)

Automated coverage (`node --test tests/`) mocks the provider at the HTTP
boundary and Neon via the `~/lib/db` stub. This checklist covers what only a
live page pass can: real provider output, layout, and download behavior.
Requires `MODEL_API_KEY` + `MUSE_IMAGE_MODEL` in Vercel env (server-only).

1. Pick a reel (left), a product + variant (right); confirm the review table mirrors the picks.
2. Generate panel unlocks. Generate each of the 6 styles
   (`flat-lay`, `folded-stack`, `single-stack`, `ghost-mannequin`, `hanger`, `on-actor`);
   confirm a preview renders with the correct `sourceMode` caption
   (with-image vs text-only), picks stay selected, no redirect.
3. Regenerate the same style; confirm a new preview without losing picks.
4. Discard (plain GET reload); confirm nothing is written (history unchanged).
5. Keep; confirm the image appears in history (newest first) with style badge.
   Keep the same image again; confirm "Already kept — exactly one record saved."
6. Download control: same-origin URL downloads with a product+style filename;
   cross-origin degrades to open-in-new-tab.
7. Failure drill (revoke key or throttle): exact cause inline
   (no-keys / rate-limit / content-filter / 5xx / timeout), picks intact.
