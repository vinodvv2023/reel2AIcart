# Reel2AICart — From Reel to AI Cart in One Click

> A Shopify app + backend service that makes any Shopify store ready for two futures at once:
> **humans shop from video** and **AI agents shop for humans**.
> Built with Muse Spark Open. Stack: **Vercel (Remix) + Modal (GPU) + Neon Postgres + pgvector**.

> ⚠️ **Distribution status: private (unpublished).** Reel2AICart is **not listed** on the Shopify App Store and the Meta App is in **development mode** — you cannot find either by search. Install via the direct install link from the Shopify Partners dashboard (test/dev store) and invite-only Meta App roles. Public listing on both platforms is pending app review.

## What it is

- **Shoppable video:** Instagram Reels / YouTube Shorts and Shopify product videos are analyzed **once per video** (offline), cached, and served as timeline-tagged products on the PDP and on Instagram itself.
- **Agent-ready commerce:** an MCP server at `/mcp/{shop}` exposes 4 tools (`search_products`, `get_product_details`, `get_inventory`, `get_video_summary`) so any agent (Meta AI, Muse, ChatGPT, Claude) can query the store without re-running vision.
- **AI product imagery (Muse Image 1.0):** optional per-product generation inside `/connect` — 6 display styles (flat-lay + wrinkle-free toggle, folded stack, single stack, ghost mannequin, hanger, on-actor), grounded on the Shopify product photo via the image-edits endpoint; preview → keep → download / push to Shopify Files. $0.01 per image, never touches the live catalog image.
- **Merchant dashboard (embedded):** pipeline health, catalog scan, store readiness, webhook deliveries, enrichment outcomes, tag-a-reel workspace (`/connect`), agent search (`/agent`).

Core insight: use Muse Spark's native multimodal perception **once per video offline**, cache the result in Neon, and never re-extract on every view. Cuts inference cost ~95%.

## What it solves

| # | Merchant pain | Old reality | What Reel2AICart does |
|---|---|---|---|
| 1 | Manual tagging hell (200 reels × 30 products = 10+ hrs) | Facebook & Instagram app syncs catalog only; merchant tags by hand | Ingestion pulls `/me/media`, dedupes by SHA256 hash, enriches once via Muse Spark, auto-tags via `POST /{ig_media_id}/product_tags` (YouTube ingestion + Shopping feed push are stubs — see Not yet implemented) |
| 2 | Dead video on PDP | Video sits on product page, does nothing | Theme App Extension: video left, products change at 00:08 / 00:15 from timeline JSON, variant pre-selected |
| 3 | No agent commerce | No MCP for custom stores; agentic storefronts closed beta, not video-aware | MCP server with 4 tools reading Neon cache (<20 ms, zero vision) |
| 4 | Commerce Account setup hell (`IE_30007`, `IE_30002`, `IE_30010`, "Failed to Replace Commerce Account") | Raw `{{IE_…}}` placeholders, failing loop when account under review | `{{IE_}}` → human message + fallback to on-site widget (YouTube: planned); documents that IG tags only show in the mobile app, not desktop web |
| 5 | No video attribution | Can't tell if a sale came from a Reel at 00:08 | Every PDP URL carries `?agent_source=instagram_reel&agent_video_id=…&agent_t=08&utm_source=…`; orders attributed via `note_attributes._shopify_video` → `order_attribution` table |
| 6 | Weak/missing catalog imagery (single supplier photo) | Reshoots per SKU | Optional Muse Image 1.0 generation in `/connect`: pick product → style → preview (prompt + request shown) → keep; reference photo attached via the edits endpoint; history in `generated_images`; download or push to Shopify Files; failures show the provider's response. Live catalog image never mutated |

## Architecture (5 layers)

```
[Shopify] --OAuth/Webhooks--> Vercel (Remix app) --async--> Modal GPU jobs
[Instagram Graph + YouTube API] --> Vercel --> Modal
              |
              v
Neon Postgres + pgvector (single source of truth)
              |
              v
MCP Server (Vercel Edge) + IG tags + YouTube feed + Theme widget
```

- **L1 Ingestion (Vercel):** Shopify Admin API, IG Graph (YouTube: planned). Webhooks ack 200 in <100 ms, then enqueue to Modal. Hash dedupe (`SHA256(video_url)`).
- **L2 Enrichment (Modal, `modal/enrich_video.py`):** `enrich_video(video_url, hero_images)` on A10G, scales to 0. Vision provider switch via secret (`muse` default, `gemini` planned, `heuristic` fallback). Writes JSON + embedding to Neon. Never called on the hot path.
- **L3 Index (Neon + pgvector):** `video_embeddings` (hash, `vector(1024)`, summary JSONB, HNSW index) + `video_cache` (replaces Redis) + `shops`, `webhook_events`, `scan_jobs`, `tag_events`, `ingest_jobs`, `order_attribution`. See `db/schema.sql`.
- **L4 Agent-ready (Vercel Edge + Neon):** MCP at `/mcp/{shop}` — GET legacy query-param shape + POST MCP Streamable HTTP (JSON-RPC: initialize, ping, tools/list, tools/call). Neon reads only.
- **L5 Activation (Vercel + APIs):** IG product tags, theme widget, UTM attribution. (YouTube Content API feed: stub.)

**Offline vs online path:** OFFLINE = new hash → Modal → Muse Spark → Neon (~$0.10–0.30/video, once). ONLINE = user/agent → `get_video_summary` hits Neon cache, `search_products` pgvector cosine search — zero inference.

## Prerequisites

- Node 20+, npm
- A Shopify store (dev store for testing) + [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm i -g @shopify/cli`)
- Neon Postgres account (free tier OK)
- Vercel account
- Modal account + `pip install modal`, `modal setup`
- Meta: Business Manager + Facebook Page + Instagram Business/Creator account, Meta developer App
- Optional: DeepInfra token (bge embeddings), Meta Model API key (Muse vision)

## Install

### 1. Clone + install deps

```bash
git clone <repo-url> reel2AIcart
cd reel2AIcart
npm install
```

### 2. Database (Neon) — run once

Create a Neon project, copy the connection string, then in the Neon SQL editor run:

```bash
# file: db/schema.sql
```

i.e. execute the contents of `db/schema.sql` (creates `vector` extension + all tables + HNSW index).

### 3. Env vars

```bash
cp .env.example .env   # then fill in values (never commit .env)
```

| Var | Where from | Purpose |
|---|---|---|
| `DATABASE_URL` | Neon dashboard → **pooled** connection string (`…-pooler…` + `?sslmode=require`) | Postgres + pgvector. Vercel uses the Neon serverless HTTP driver (`app/lib/db.ts`, no local Postgres); Modal's `psycopg2` uses the same URL as plain Postgres |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify Partners dashboard → App → Client ID/Secret | OAuth. Already in `shopify.app.toml` (`client_id = 440af85bd85a43647ef6eb17285200b0`) |
| `APP_URL` | Your Vercel URL (default `https://reel2-aicart.vercel.app`) | Base-URL override for `scripts/agent_demo.py` + `bulk_e2e.py` only — the app and `shopify.app.toml` hardcode the URL (see Fork checklist) |
| `MODAL_WEBHOOK_URL` | Output of `modal deploy modal/enrich_video.py` (the `ingest` endpoint URL) | Vercel → Modal handoff |
| `MODAL_INGEST_SECRET` | You generate; also set as Modal secret `modal-auth` (`MODAL_INGEST_SECRET`) | Shared secret: Vercel embeds in payload, Modal checks it |
| `META_GRAPH_TOKEN` | Meta (see Configure Facebook below — system-user token, never expires) | IG media read + product tagging |
| `IG_USER_ID` | `{page-id}?fields=instagram_business_account` or the Add-account wizard | IG business account id |
| `META_APP_ID` / `META_APP_SECRET` | Meta App → Settings → Basic | Only for the 60-day token-exchange fallback |
| `VISION_PROVIDER` / `EMBED_PROVIDER` | Set to `muse` (hackathon default) | Modal secret `app-config` |
| `MODEL_API_KEY` (or `META_API_KEY`), `META_BASE_URL`, `MUSE_VISION_MODEL`, `MUSE_EMBED_MODEL` | dev.meta.ai | Modal Muse vision + embeddings (`MUSE_EMBED_MODEL` optional — unset falls back to hash vectors). `MODEL_API_KEY` doubles as the /agent Ask-tab Muse key and the image-generation key |
| `MUSE_IMAGE_MODEL` | dev.meta.ai | Muse Image 1.0 model id for `/connect` generation (default `muse-image-1.0` when unset). Billed $0.01 per generated image |
| `DEEPINFRA_TOKEN`, `DEEPINFRA_EMBED_MODEL` | DeepInfra dashboard | bge-large (native 1024-dim). Modal embeddings when `EMBED_PROVIDER=deepinfra` AND the server-side bge re-rank in `/mcp` + `/agent` search — unset silently falls back to hash/text matching |
| `CRON_SECRET` | You generate (`openssl rand -hex 32`) | Bearer secret for Vercel cron endpoints (`/api/scan-worker`, `/api/attribute-orders`). Just set the var — Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on cron invocations, no extra config |
| `XAI_API_KEY`, `GROK_MODEL` | x.ai console | /agent Ask-tab second provider (`grok`). Muse (default) needs no extra var beyond `MODEL_API_KEY` |

### 4. Modal worker

```bash
modal secret create neon DATABASE_URL="postgresql://…"
modal secret create modal-auth MODAL_INGEST_SECRET="<same-value-as-vercel>"
modal secret create app-config VISION_PROVIDER=muse EMBED_PROVIDER=muse
modal secret create meta MODEL_API_KEY="<key>" META_BASE_URL="https://api.meta.ai/v1" MUSE_VISION_MODEL="<model>"
# create placeholder secrets if unused: gemini, deepinfra
modal deploy modal/enrich_video.py
# copy the ingest endpoint URL → MODAL_WEBHOOK_URL in Vercel + .env
```

#### 4a. How it works (`modal/enrich_video.py`, app `reel2aicart-enrich`)

- **`ingest` — front door (CPU-only, 60s).** Modal web endpoint. Vercel POSTs `{video_url, hero_images, shop, product_id, job_key, callback_url, callback_secret, secret}`; wrong/missing `secret` (checked against `modal-auth`) → 401, nothing spawned. Otherwise `enrich_video.spawn(...)` and return `{ok, spawned}` immediately — Vercel never waits for GPU work.
- **`enrich_video` — GPU worker (A10G, 300s, scales to 0).**
  - *Media resolution:* no `video_url`? Resolves via Shopify product-media GraphQL with the stored token from `shops`. No media at all → `skipped`.
  - *Dedupe:* `video_hash = SHA256(video_url)` — one video, one inference, forever.
  - *Vision* (provider from `app-config`, `muse` default): Muse Spark via Meta Model API (OpenAI-compatible chat) — prompt + ≤3 hero images, retrying while dropping one image at a time on `media_url_not_fetchable` → `{products[], scene}` mapped to the timeline contract (`00:00/00:08/00:15`). Any failure → `heuristic-v1` fallback; `gemini` stubbed for later.
  - *Embedding:* Muse (if `MUSE_EMBED_MODEL` set) → DeepInfra `bge-large` (native 1024-dim) → hash-LCG fallback that exactly mirrors `app/lib/video/embed.ts` (so MCP query vectors rank correctly). All vectors fit to 1024 dims + L2-normed for the `vector(1024)` HNSW index.
  - *Write:* upserts `video_embeddings` (`ON CONFLICT(video_hash) DO UPDATE` guarded by `WHERE verified IS DISTINCT FROM TRUE`) + `video_cache`.
  - *Callback:* best-effort POST to `/api/ingest-callback` with the shared secret → `ingest_jobs` goes `sent → enriched/skipped/failed`. Never breaks enrichment if Vercel is unreachable.
- **Secrets:** `neon, meta, gemini, deepinfra, app-config` on the worker, `modal-auth` only on `ingest`. Create placeholder values for unused providers so deploy never fails — switching providers is a secret change, zero code change.

### 5. Shopify app (via [dev.shopify.com](https://dev.shopify.com))

All app identity, stores, and installs live in the Shopify dev dashboard — do this once before/instead of the CLI:

1. **Log in** at [dev.shopify.com](https://dev.shopify.com) (free developer/Partner account; create an organization on first visit).
2. **Create the dev store:** Stores → Add store → development store (e.g. `reel2aicart-test.myshopify.com`). Free forever for testing. Its storefront is password-gated — the password is set in the store admin under Preferences (ours: `ChangeMe!`).
3. **Open the app:** Apps → **Reel2AICart**. (Forking with your own credentials? Create app instead, then copy its Client ID into `client_id` in `shopify.app.toml` and into `SHOPIFY_API_KEY` in `.env`.)
4. **Configuration** (must mirror `shopify.app.toml` — `shopify app deploy` pushes the toml so both stay in sync):
   - App URL: `https://reel2-aicart.vercel.app`
   - Allowed redirection URLs: `https://reel2-aicart.vercel.app/auth/callback`, `https://reel2-aicart.vercel.app/auth/shopify/callback`
   - Access scopes: `read_products, read_inventory, read_content, write_content, read_orders`
   - Webhook subscriptions (API 2026-10): `products/create`, `products/update`, `inventory_levels/update` → `https://reel2-aicart.vercel.app/webhooks/shopify`
5. **Client credentials:** App → Settings → copy Client ID / Client secret → `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` in `.env` and Vercel env.
6. **Install on the dev store:** App → Test your app (install) → select the dev store → approve the scopes. The OAuth callback writes the shop token to the `shops` table; webhooks register at deploy. Distribution stays **Test/private** until App Store submission (see banner at top).

CLI (keeps toml ↔ dashboard in sync after dashboard edits):

```bash
shopify app dev        # local dev: OAuth + webhooks tunnel
shopify app deploy     # pushes shopify.app.toml (scopes, webhooks, theme extension)
```

`shopify.app.toml` already declares the scopes, webhooks, theme app extension (`extensions/shoppable-video-widget`), and redirect URLs listed above.

#### 5b. Fork checklist — the app URL is hardcoded

No `SHOPIFY_APP_URL` env var is read anywhere. Before deploying under your own domain, replace `https://reel2-aicart.vercel.app` in: `shopify.app.toml` (`application_url`, both `redirect_urls`, webhook `uri`), and `app/routes/auth.login.tsx` (`redirect_uri` — OAuth fails with a redirect mismatch otherwise, **including** `shopify app dev` tunnel URLs). Optionally also `public/openapi.yaml` and `app/routes/agent.tsx` (fallback shop); `scripts/*.py` already accept an `APP_URL` env override. Find every spot with:

```bash
rg "reel2-aicart\.vercel\.app" --glob '!node_modules' --glob '!.git'
```

Then mirror the same URLs in the dev-dashboard Configuration (§5 step 4) and redeploy (`shopify app deploy`).

### 6. Deploy web (Vercel)

```bash
npm run build
# vercel: import repo, set all env vars above, deploy
# crons in vercel.json run automatically: /api/scan-worker (*/5), /api/attribute-orders (*/15)
```

### 7. Verify

Test storefront: [reel2aicart-test.myshopify.com](https://reel2aicart-test.myshopify.com) — password-gated, password is `ChangeMe!`. The dashboard home also has a **View storefront** link (derived from the installed shop) for one-click access.

1. Open the embedded app in store admin → dashboard shows pipeline health.
2. Save a product → Recent webhook deliveries shows `forwarded`; Enrichment outcomes goes `sent → enriched`.
3. `Scan existing catalog` backfills without touching verified rows.
4. `GET /mcp/{shop}?tool=get_video_summary&video_id=…` returns cached JSON (<20 ms).

## Configure Shopify (necessary apps + settings)

These are the Shopify-side pieces the app depends on:

1. **Reel2AICart custom app (this repo)** — install on the store via the Partners-dashboard install link (private distribution, see banner above). Grants `read_products, read_inventory, read_content, write_content, read_orders`; subscribes to product/inventory webhooks. Required for sync, enrichment triggers, and MCP data.
2. **Facebook & Instagram sales channel** (public, Shopify App Store, by Meta — free) — this is the bridge that syncs your Shopify catalog to Meta. Reel2AICart depends on it: the `/connect` tag flow sends the Shopify **variant ID as the Meta catalog product ID**, so tagging only works if this channel has synced that variant into the Meta catalog. See §2a below for the full connect walkthrough.
3. **Theme App Extension** (`extensions/shoppable-video-widget/`) — shipped in this repo via `shopify.app.toml`. After deploy: Online Store → Themes → Customize → add the **Shoppable Video** block to the PDP template. Block settings: **Video ID** = the `video_hash` from Neon (dashboard Enrichment outcomes / `video_cache.video_id`), **Video URL** = MP4 or embed. On load the widget GETs the timeline and swaps the product rail as the video plays (`timeupdate` vs timeline `t`), appending `utm_source=reel2aicart&utm_medium=shoppable&utm_campaign=<video_id>&utm_content=<t>` to PDP links.
   - ⚠️ **Same-origin gotcha:** `assets/widget.js` fetches the **relative** path `/api/video-summary?video_id=…`, which on the storefront resolves against `*.myshopify.com` (404) — not your Vercel app. There is no app proxy in `shopify.app.toml`. Before the widget can render products, point that fetch at your absolute app URL (`https://<your-app>/api/video-summary?video_id=…`) or add an app proxy. Until then the block shows its fallback text ("Products in this video will appear here").
4. **Products with media** — upload at least one video (or external/YouTube video) or hero images per product; enrichment resolves media via product-media GraphQL and falls back to hero images.
5. **Video attribution chain (you must wire the middle link).** Both order readers look for a **`_shopify_video` order note attribute**: the `/api/attribute-orders` cron reads order `customAttributes` via GraphQL, and `/webhooks/orders` reads `note_attributes` from the webhook/Flow payload — either writes `order_attribution` rows visible in Shopify Analytics via UTM params. The widget only sets a **`_shopify_video` cookie** (`assets/widget.js`) — **nothing in this repo copies that cookie into cart/checkout note attributes yet**, so without your bridge, attribution silently records nothing. Minimal bridge (theme JS, runs before checkout):
   ```js
   fetch('/cart/update.js', { method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ attributes: { _shopify_video: getCookie('_shopify_video') } }) });
   ```
   (Cookie value is the video_id; only set it when present.)

   #### 5a. Attribution without approval — Shopify Flow (recommended until `orders/*` webhooks are approved)
   The native `orders/create` webhook carries protected customer data and needs Shopify approval before it fires. Skip the wait: a Shopify Flow **Send HTTP request** action needs no approval:
   - Trigger: Order created. Action: Send HTTP request → POST `https://<your-app>/webhooks/orders`.
   - Headers: `x-flow-secret: <CRON_SECRET>` (same value as Vercel env — the endpoint accepts this instead of HMAC).
   - Body: any JSON with `id` plus `note_attributes[]` or a direct `video_id` (e.g. `{"id": "{{order.id}}", "note_attributes": {{order.noteAttributes}}}`) — see `app/routes/webhooks.orders.tsx`.
   - Verify: dashboard Recent webhook deliveries shows `orders/flow → attributed`.

### 2a. Connecting "Facebook & Instagram by Meta" (step-by-step)

In Shopify admin: **Settings → Apps and sales channels → Shopify App Store → search `facebook & instagram by meta`** (publisher **Meta**, free) → **Install**.

The onboarding wizard then connects, in order:

1. **Connect Facebook account** — log in with a Facebook user that has admin on the Business Manager. Grant the requested permissions (manage Business assets, catalog, Page, Instagram account, ads — the channel cannot sync or tag without them; if you decline any, go back and re-grant or sync/tagging silently fails).
2. **Select Business Manager** — pick the Business that owns the store's Page, catalog, and Commerce Account.
3. **Connect Page + Instagram** — select the Facebook Page and the linked Instagram professional (Business/Creator) account shoppers will see tags on.
4. **Connect Commerce Account + catalog** — select (or create) the Commerce Account and the catalog the channel syncs products into. **Use the same Commerce Account + catalog as the Meta setup below** — mismatched accounts are the #1 cause of `IE_30007` / "Failed to Replace Commerce Account" loops.
5. **Ad account + Meta Pixel + data sharing** — select the ad account, enable the Pixel, and set data sharing to **Maximum** so checkout/video-attribution events flow back (feeds the `order_attribution` / UTM reporting in §What it solves #5).
6. **Domain verification** — verify the store domain when prompted (fixes `IE_30002` domain-mismatch errors).
7. **Review + accept terms** — finish; catalog sync starts (can take minutes–hours for large catalogs).

What must be **enabled/healthy for Reel2AICart to function**:

- [ ] Channel status **Active** (Apps and sales channels → Facebook & Instagram shows connected, no error banner).
- [ ] Catalog sync complete — the variant you want to tag appears in Commerce Manager with a content ID equal to the Shopify variant ID.
- [ ] Commerce Account **approved** (not under review — under review gives `IE_30010`; on-site widget + YouTube keep working meanwhile).
- [ ] Instagram account is **Professional** and linked to the Page; product tagging renders **mobile-app only**.
- [ ] Products in stock and compliant with Meta Commerce Policies, store in a supported market — otherwise tags are rejected even with everything else green.

## Configure Facebook / Meta (necessary apps + setup)

Instagram tagging goes through Meta — set these up once per merchant:

1. **Meta developer App** ([developers.facebook.com](https://developers.facebook.com) → Create App, type Business):
   - Add products: **Instagram Graph API** (+ Facebook Login if using OAuth login).
   - Settings → Basic → copy **App ID** (`META_APP_ID`) and **App Secret** (`META_APP_SECRET`).
   - Required OAuth scopes for the app/token: `instagram_basic`, `instagram_content_publish`, `business_management` (plus catalog perms for tagging).
2. **Business Manager + assets** ([business.facebook.com](https://business.facebook.com)):
   - Create/claim Business → add the Facebook **Page**, the **Instagram Business/Creator account** (IG Settings → Account type → Switch to Professional, then link to the Page), and the ad/catalog people.
   - **Domain verify** the store domain (Business Settings → Brand Safety → Domains) — fixes `IE_30002` domain-mismatch errors.
3. **Commerce Account + catalog (Commerce Manager** ([business.facebook.com/commerce](https://business.facebook.com/commerce)**)):**
   - Create a Commerce Account → attach the catalog synced by the Shopify Facebook & Instagram channel → submit for review.
   - `IE_30007` = catalog not approved → fix here. `IE_30010` = account under review → keep selling via the on-site widget meanwhile (YouTube: planned; the app shows this message instead of the raw `{{IE_…}}` placeholder).
   - Connect the **Facebook & Instagram** sales channel in Shopify to this same Commerce Account (walkthrough in §2a above).
4. **System-user token (recommended — never expires):**
   - Business Settings → System Users → Admin system user → Add assets (Page, IG account, catalog, App) → Generate token with the scopes above → set as `META_GRAPH_TOKEN`.
   - Fallback: short-lived user token exchanged to 60-day via `META_APP_ID/SECRET` (the app only needs this for the exchange path).
5. **Find `IG_USER_ID`:** `GET {page-id}?fields=instagram_business_account` with the token, or use the in-app Add-account wizard.
6. **In-app:** open `/connect` → status shows connected when `META_GRAPH_TOKEN + IG_USER_ID` are set. Pick reel (left) + product/variant (right) → review → **Tag products on reel**. Verify on **Instagram mobile app** — product tags do **not** render on desktop web (`instagram.com/.../reels` shows no View Products; this is a Meta limitation, documented in-app).

## Not yet implemented (stubs with TODOs — don't mistake for bugs)

- **YouTube:** ingestion (`videos.list`) + Shopping feed push — `app/lib/activation/youtube.ts` is a `TODO` stub; all YouTube mentions elsewhere describe the target design, not working code.
- **Gemini vision:** Modal `_vision_summary` falls through to `heuristic-v1`; wire it later via the `app-config` secret (no code change to flip providers).
- **Muse embeddings:** until `MUSE_EMBED_MODEL` is set, vectors are deterministic hash-LCG (rank-compatible with stored rows, not semantic).

## Usage

- `/` — dashboard: video cache / embedding counts, enrichment worker status, Scan existing catalog, how-to-test card, store readiness (webMCP), webhook deliveries, enrichment outcomes, agent search FAB.
- `/connect` — Tag-a-reel workspace (reels left, products right, optional Muse Image 1.0 generation, review table, tag action; tag history in `tag_events`, image history in `generated_images`).
- `/agent` — full chat/search over shoppable videos with PDP links. Two tabs: **Ask** (multi-turn function-calling; `muse` default via `MODEL_API_KEY`, hardcoded model `muse-spark-1.3-contributor` — or `grok` via `XAI_API_KEY` + `GROK_MODEL`) and **Search** (direct vector cards over `/mcp`; bge re-rank needs `DEEPINFRA_TOKEN`). Ask links carry `utm_source=agent-chat`.
- `/scan?shop=…` — scan progress page.
- `/mcp/{shop}` — MCP endpoint. Tools: `search_products(query, image_embedding?, price_max?)`, `get_product_details(sku)`, `get_inventory(sku)`, `get_video_summary(video_id)`. GET legacy params or POST MCP Streamable HTTP.
- `/openapi.yaml` — agent entry contract.

## Dashboard tour — what each button does

Open `https://<your-app>/?shop=<your-shop>` (the `?shop=` comes automatically when you open the app from the store admin; without it the page shows "unknown shop" and falls back to the first installed tenant).

### Home (`/`)

- **Pipeline health card** — confirms which shop you're viewing. Opened directly (no `?shop=`)? It lists installed tenants as links (`/?shop=…`) so you can jump into the right one.
- **Stats cards (read-only):** **Video cache** = enriched summaries served `<20ms` with no vision; **Video embeddings** = pgvector rows the MCP/agent search ranks over; **Enrichment worker** = `connected` when `MODAL_WEBHOOK_URL` is set, `not configured` otherwise (enrichment can't run until it is).
- **Connect Instagram** → `/connect` (tag-a-reel workspace, below).
- **Reconnect store** → `/auth/login?shop=…` — starts a *fresh* OAuth grant (unlike Test-app reinstalls, which reuse the old grant). Use when the readiness card says `token: dead` or scopes are missing.
- **View storefront** → `https://<shop>` in a new tab (derived from the installed shop, so it always points at the right store). Below it: the test-storefront password hint.
- **Catalog scan card** — backfills enrichment without manual re-saves; verified rows are never touched.
  - **Scan existing catalog** (POST `/api/scan`) — queues one scan job (one Admin page of 250 products per cron tick, `~2 req/s` safe). While open, the button flips to a disabled **Scan in progress** state.
  - **Watch progress** → `/scan?shop=…` (monitor page, below).
  - Banners: `Scan complete — N checked, M analyzed(, K need review)`, or `Scan stopped: <error>`.
- **How to test card** - guided demo loop, no need to add products first: **Delete one entry** removes ONE product's AI summary from the index (Shopify products untouched; verified rows never eligible) → **Scan existing catalog** spots the gap and sends it for analysis → **Enrichment outcomes** flips `sent - outcome pending` to `enriched` while the embeddings count climbs back. **2 test resets per browser** (cookie `r2ac_test_deletes`; button shows remaining); the 3rd attempt is refused with *"You have tried the maximum for testing."* Clearing cookies resets it — soft gate for test stores, not security.
- **Store readiness (webMCP) card** — one line per check: shop, `token ok/dead`, `scopes ok` or `missing: …`, `MCP ready/error` (`ready` = token + scopes + ≥1 embedding row), row count, check count, timestamp.
  - **Re-check** (POST `/api/activate`, per shop) — re-runs the activation check now and returns a banner like `Re-check 14:22 UTC - token ok, scopes ok, MCP ready (38 rows)`. No navigation; result shows on the same card.
  - Note line: webhooks are declared at deploy; **openapi.yaml** link = the agent entry contract.
- **Recent webhook deliveries** — last 10 inbound events (`topic`, `forwarded/failed`, reason, time). Empty state tells you the smoke test: *"save a product to fire one."*
- **Enrichment outcomes** — last 10 Vercel→Modal handoffs (`webhook:product_id` / `scan:product_id`, `enriched` / `sent - outcome pending` / `failed`, Modal's detail, time). `sent` that never flips = `MODAL_WEBHOOK_URL`/secret mismatch or product with no media.
- **"Search with your fav agent" FAB** — floating button opening a panel: a **Search** box (GET `/agent?tab=search`, scoped to this shop) + **Go**, **Open full chat** → `/agent`, **Close**. Pure shortcut; same engine as `/agent`.

### Tag-a-reel (`/connect`)

Pick flows, all selection state in the URL (`?reel=&product=&variant=&style=`, with `pg/rpg` pages preserved across picks) so refresh/sharing never loses your picks. Picking a product resets the style; fresh searches reset to page 1.

- **Back to dashboard** (top) → `/`.
- **Intro card** — connection status (`Instagram is connected` vs `missing keys - set META_GRAPH_TOKEN + IG_USER_ID`), the Commerce-Account hint line, and the expected outcome (green confirmation + tags visible on the reel **in mobile** within minutes).
- **1. Pick a reel** — **Search reels** form (filters by caption/id, 8 per page, **Prev/Next** pager), each row shows thumbnail (or inline video preview), caption, id, date, plus a badge if *this app* already tagged it here (`Tagged here on <date>` green / `Tag attempt failed` red — from `tag_events`, survives token expiry). Header links out to the Instagram profile so viewers can check the source reels.
- **2. Pick a product** — **Search products** form (by title), same paging; header links out to the Shopify store so viewers can check the catalog. Multi-variant products open a **variant dialog** listing each variant + price + id (the id is sent as the Meta catalog product ID — see §2). **Done** closes the dialog.
- **3. Generate product image (optional)** — after picking a product: 6 style pills (`flat-lay`, `folded-stack`, `single-stack`, `ghost-mannequin`, `hanger`, `on-actor`; flat-lay carries a **Wrinkle free** checkbox, default on). **Generate/Regenerate** shows a full-size preview plus a **Prompt & request details** disclosure (style, model, endpoint, reference attachment, full prompt, request body — visible before generating too, computed from your picks). **Keep/Discard**, **Download**, history thumbnails (newest first), and **Push to Shopify Files** (explicit confirmed export; upgrades the stored row to the CDN URL). Failures show a **Why did this fail?** disclosure with the provider's response. Nothing here touches the live catalog image.
- **4. Review and tag** — mirror table of your three picks + **Clear** (resets the URL state). **Tag products on reel** (POST) is disabled until reel + product + variant are all chosen; on success/failure a banner shows the outcome (`Tagged reel <id> - check the reel on mobile…` vs the exact Graph error, logged to `tag_events` either way).

### Assistant (`/agent`)

- **Back to dashboard** — preserves `?shop=` when known.
- **Ask / Search pills** — switch `?tab=` (highlighted pill = active).
- **Search tab** — product search box + **Search** (GET; up to 8 cards). Each card: hero image (or letter placeholder), summary excerpt, vector `score`, **View product** link (PDP + `utm_source=agent-chat`). `No matches.` when empty.
- **Ask tab** — multi-turn chat (history rides in a hidden form field, last 7 turns kept). **Agent** dropdown: `Muse Spark` (default, `MODEL_API_KEY`, model `muse-spark-1.3-contributor`) or `Grok` (`XAI_API_KEY` + `GROK_MODEL` — missing model gives a "Set GROK_MODEL…" error). Question box (300 chars) + **Ask**. The model may call `search_products`/`get_video_summary` (max 3 tool rounds); the reply footer shows `Answered by … · tools: …`. System prompt forces product names + PDP links and forbids inventing products/prices. Empty question → `Type a question first.`

### Scan monitor (`/scan?shop=…`)

- **Status card** — `No scans yet.` / live progress (`checked N items…, M sent for analysis`) / **done breakdown** (checked N · already-done skipped · M sent, finishes on its own in minutes · K need review) / **failed + "Try again from the dashboard."** Auto-refreshes every 30s (meta refresh, no JS) *only* while a job is open.
- **Back to dashboard** (preserves shop).
- **Vision quality line** — `N analyzed in detail` (Muse vision rows) vs `M basic info only` (heuristic/hash rows). Tells you at a glance how much of the catalog got real AI analysis.
- **Verified rows (frozen)** — up to 50 rows (hash prefix, video URL, vision provider) each with a **Release** button (POST `/api/release`), plus **Release all**. Releasing *unfreezes* a row (`verified=false`) so the next scan/re-save may re-enrich it — freezing is the default, every release is an explicit click. Redirects back here (`?from=scan`) or home.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| `{{IE_30007}}` / `{{IE_30002}}` / `{{IE_30010}}`, "Failed to Replace Commerce Account" | Commerce Account issue — app humanizes it: catalog not approved / domain mismatch / under review → fix in Commerce Manager; use on-site widget meanwhile (YouTube: planned) |
| No View Products on reel (desktop web) | Expected — Meta only renders IG product tags in the mobile app; test on phone |
| `IG keys missing` / `IG API 4xx` on `/connect` | `META_GRAPH_TOKEN`/`IG_USER_ID` unset or expired → regenerate system-user token |
| `Shopify API 401` | Token dead → Reconnect store; readiness card shows `token: dead` + missing scopes |
| Enrichment stuck `sent` | `MODAL_WEBHOOK_URL`/secret mismatch, or product has no media → check `ingest_jobs.detail`, Modal logs |
| Verified rows overwritten | Impossible by design — upsert has `WHERE verified IS DISTINCT FROM TRUE`; release per row explicitly |
| Widget shows fallback text, no products | `widget.js` relative `/api/video-summary` fetch 404s on the storefront → use the absolute app URL or an app proxy (see Configure Shopify item 3); also confirm block Video ID = `video_hash` |
| OAuth "redirect_uri is not whitelisted" (incl. `shopify app dev` tunnel) | `auth.login.tsx` hardcodes the prod URL → Fork checklist (§5b) |
| Attribution rows never appear | Cookie→note bridge missing (Configure Shopify item 5); or Flow `x-flow-secret` ≠ `CRON_SECRET`; or native orders webhook pending approval → use Flow (§5a) |
| Cron endpoints 401 in logs | Normal if `CRON_SECRET` unset — set it in Vercel env; Vercel sends the header automatically |
| Test reset button disabled / "maximum for testing" | 2 resets per browser (cookie `r2ac_test_deletes`) — clear cookies for that browser to test again |
| YouTube feed / Gemini vision missing | Stubs, not bugs — `app/lib/activation/youtube.ts` is a TODO, Modal `gemini` provider is planned (see Not yet implemented) |
| `docs/` empty after clone | Expected — `docs/` is gitignored (local-only). Key decisions are summarized in this README |

## Project structure

```
app/                  Remix app (Vercel)
  routes/             /, /connect, /agent, /scan, /mcp.$shopId, /api.*, /webhooks.*, /auth.*
  lib/                db.ts, mcp/, shopify/, video/, activation/, image/ (Muse Image 1.0 prompt builder + provider calls)
  tokens.css          shared r2ac styles
extensions/shoppable-video-widget/   Theme App Extension (PDP widget)
modal/enrich_video.py Modal GPU: Muse vision + embeddings → Neon (+ ingest webhook)
db/schema.sql         Neon tables + pgvector HNSW index (re-runnable: all `IF NOT EXISTS`)
db/migrate-*.sql      One-off migrations (Neon-editor-safe, idempotent — e.g. `generated_images` table, style-vocabulary rename)
tests/                node:test suite, zero new deps (route action/loader tests via a transpile harness) + manual `/connect` checklist
db/cleanup-shop.sql   Fresh-start reset (Neon-SQL-editor-safe; psql `\set` unsupported there)
docs/                 PRD, checklists, scan/activation, tag visibility — GITIGNORED, local-only: fresh clones don't get it
scripts/              agent_demo.py (MCP function-calling demo) + bulk_e2e.py (Modal-parity bulk enrich)
shopify.app.toml      App config: scopes, webhooks, extension
```

## Cost (~$20–25/mo + inference)

Vercel Pro ($0–20) + Neon (free 0.5 GB, then ~$5) + Modal pay-per-second (~$10–15 for 500 videos) + Vercel Blob/R2 ($0). Drops Qdrant/Upstash/Fly (~$125/mo → ~$25/mo). Inference $0.10–0.15/video self-hosted, once per video, cached forever. Image generation $0.01 per generated image (Muse Image 1.0; failed generations aren't billed).

## Scripts

- `npm run dev` — local Remix dev
- `npm run build` — production build
- `npm test` — node:test suite (route + service tests, all provider/DB edges mocked)
- `npx tsc --noEmit` — typecheck (`npm run typecheck`)
- `python scripts/agent_demo.py "maroon gown"` — Muse function-calling over MCP tools. Needs `MODEL_API_KEY` in env; `APP_URL`/`SHOP` env overrides (defaults: prod app + test shop). Stdlib only.
- `python scripts/bulk_e2e.py [--write] [--shop SHOP]` — Modal-parity bulk enrichment + MCP probes. Default is dry-run; `--write` upserts `provider=bulk-local-v1` rows (needs `DATABASE_URL` in `.env` + `psycopg2-binary` in `.venv`). Clean up test rows with: `DELETE FROM video_cache WHERE video_id IN (SELECT video_hash FROM video_embeddings WHERE summary->>'provider'='bulk-local-v1'); DELETE FROM video_embeddings WHERE summary->>'provider'='bulk-local-v1';`
