# Reel2AICart — From Reel to AI Cart in One Click

> A Shopify app + backend service that makes any Shopify store ready for two futures at once:
> **humans shop from video** and **AI agents shop for humans**.
> Built with Muse Spark Open. Stack: **Vercel (Remix) + Modal (GPU) + Neon Postgres + pgvector**.

> ⚠️ **Distribution status: private (unpublished).** Reel2AICart is **not listed** on the Shopify App Store and the Meta App is in **development mode** — you cannot find either by search. Install via the direct install link from the Shopify Partners dashboard (test/dev store) and invite-only Meta App roles. Public listing on both platforms is pending app review.

## What it is

- **Shoppable video:** Instagram Reels / YouTube Shorts and Shopify product videos are analyzed **once per video** (offline), cached, and served as timeline-tagged products on the PDP and on Instagram itself.
- **Agent-ready commerce:** an MCP server at `/mcp/{shop}` exposes 4 tools (`search_products`, `get_product_details`, `get_inventory`, `get_video_summary`) so any agent (Meta AI, Muse, ChatGPT, Claude) can query the store without re-running vision.
- **Merchant dashboard (embedded):** pipeline health, catalog scan, store readiness, webhook deliveries, enrichment outcomes, tag-a-reel workspace (`/connect`), agent search (`/agent`).

Core insight: use Muse Spark's native multimodal perception **once per video offline**, cache the result in Neon, and never re-extract on every view. Cuts inference cost ~95%.

## What it solves

| # | Merchant pain | Old reality | What Reel2AICart does |
|---|---|---|---|
| 1 | Manual tagging hell (200 reels × 30 products = 10+ hrs) | Facebook & Instagram app syncs catalog only; merchant tags by hand | Ingestion pulls `/me/media` + YouTube `videos.list`, dedupes by SHA256 hash, enriches once via Muse Spark, auto-tags via `POST /{ig_media_id}/product_tags` and YouTube Shopping feed |
| 2 | Dead video on PDP | Video sits on product page, does nothing | Theme App Extension: video left, products change at 00:08 / 00:15 from timeline JSON, variant pre-selected |
| 3 | No agent commerce | No MCP for custom stores; agentic storefronts closed beta, not video-aware | MCP server with 4 tools reading Neon cache (<20 ms, zero vision) |
| 4 | Commerce Account setup hell (`IE_30007`, `IE_30002`, `IE_30010`, "Failed to Replace Commerce Account") | Raw `{{IE_…}}` placeholders, failing loop when account under review | `{{IE_}}` → human message + fallback to on-site widget + YouTube; documents that IG tags only show in the mobile app, not desktop web |
| 5 | No video attribution | Can't tell if a sale came from a Reel at 00:08 | Every PDP URL carries `?agent_source=instagram_reel&agent_video_id=…&agent_t=08&utm_source=…`; orders attributed via `note_attributes._shopify_video` → `order_attribution` table |

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

- **L1 Ingestion (Vercel):** Shopify Admin API, IG Graph, YouTube Data API. Webhooks ack 200 in <100 ms, then enqueue to Modal. Hash dedupe (`SHA256(video_url)`).
- **L2 Enrichment (Modal, `modal/enrich_video.py`):** `enrich_video(video_url, hero_images)` on A10G, scales to 0. Vision provider switch via secret (`muse` default, `gemini` planned, `heuristic` fallback). Writes JSON + embedding to Neon. Never called on the hot path.
- **L3 Index (Neon + pgvector):** `video_embeddings` (hash, `vector(1024)`, summary JSONB, HNSW index) + `video_cache` (replaces Redis) + `shops`, `webhook_events`, `scan_jobs`, `tag_events`, `ingest_jobs`, `order_attribution`. See `db/schema.sql`.
- **L4 Agent-ready (Vercel Edge + Neon):** MCP at `/mcp/{shop}` — GET legacy query-param shape + POST MCP Streamable HTTP (JSON-RPC: initialize, ping, tools/list, tools/call). Neon reads only.
- **L5 Activation (Vercel + APIs):** IG product tags, YouTube Content API feed, theme widget, UTM attribution.

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
| `DATABASE_URL` | Neon dashboard | Postgres + pgvector |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify Partners dashboard → App → Client ID/Secret | OAuth. Already in `shopify.app.toml` (`client_id = 440af85bd85a43647ef6eb17285200b0`) |
| `SHOPIFY_APP_URL` | Your Vercel URL (`https://reel2-aicart.vercel.app`) | OAuth callbacks, webhooks |
| `MODAL_WEBHOOK_URL` | Output of `modal deploy modal/enrich_video.py` (the `ingest` endpoint URL) | Vercel → Modal handoff |
| `MODAL_INGEST_SECRET` | You generate; also set as Modal secret `modal-auth` (`MODAL_INGEST_SECRET`) | Shared secret: Vercel embeds in payload, Modal checks it |
| `META_GRAPH_TOKEN` | Meta (see Configure Facebook below — system-user token, never expires) | IG media read + product tagging |
| `IG_USER_ID` | `{page-id}?fields=instagram_business_account` or the Add-account wizard | IG business account id |
| `META_APP_ID` / `META_APP_SECRET` | Meta App → Settings → Basic | Only for the 60-day token-exchange fallback |
| `VISION_PROVIDER` / `EMBED_PROVIDER` | Set to `muse` (hackathon default) | Modal secret `app-config` |
| `MODEL_API_KEY`, `META_BASE_URL`, `MUSE_VISION_MODEL` | dev.meta.ai | Muse Spark vision |
| `DEEPINFRA_TOKEN` (optional) | DeepInfra dashboard | bge-large embeddings (1024-dim native) |
| `CRON_SECRET` | You generate (`openssl rand -hex 32`) | Bearer secret for Vercel cron endpoints (`/api/scan-worker`, `/api/attribute-orders`); workers 401 without it |

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

### 5. Shopify app

```bash
shopify app dev        # local dev: OAuth + webhooks tunnel
shopify app deploy     # registers shopify.app.toml (scopes, webhooks, theme extension)
```

`shopify.app.toml` already declares:
- **Scopes (minimal):** `read_products, read_inventory, read_content, write_content, read_orders`
- **Webhooks (API 2026-10):** `products/create`, `products/update`, `inventory_levels/update` → `https://reel2-aicart.vercel.app/webhooks/shopify`
- **Extension:** `extensions/shoppable-video-widget` (theme app extension — shoppable video widget)
- **Redirects:** `/auth/callback`, `/auth/shopify/callback`

Then install the app on your store (Partners dashboard → Test store, or App Store listing). OAuth writes the shop token to the `shops` table; webhooks register at deploy.

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
3. **Theme App Extension** (`extensions/shoppable-video-widget/`) — shipped in this repo via `shopify.app.toml`. After deploy: Online Store → Themes → Customize → App embeds/blocks → enable the Reel2AICart shoppable video block on PDPs. It reads timeline JSON from the Vercel API.
4. **Products with media** — upload at least one video (or external/YouTube video) or hero images per product; enrichment resolves media via product-media GraphQL and falls back to hero images.
5. **Checkout note attributes** — the widget appends `note_attributes[_shopify_video]` to the cart so `/api/attribute-orders` (cron) can write `order_attribution` rows visible in Shopify Analytics via UTM params.

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
   - `IE_30007` = catalog not approved → fix here. `IE_30010` = account under review → keep selling via the on-site widget + YouTube meanwhile (the app shows this message instead of the raw `{{IE_…}}` placeholder).
   - Connect the **Facebook & Instagram** sales channel in Shopify to this same Commerce Account (walkthrough in §2a above).
4. **System-user token (recommended — never expires):**
   - Business Settings → System Users → Admin system user → Add assets (Page, IG account, catalog, App) → Generate token with the scopes above → set as `META_GRAPH_TOKEN`.
   - Fallback: short-lived user token exchanged to 60-day via `META_APP_ID/SECRET` (the app only needs this for the exchange path).
5. **Find `IG_USER_ID`:** `GET {page-id}?fields=instagram_business_account` with the token, or use the in-app Add-account wizard.
6. **In-app:** open `/connect` → status shows connected when `META_GRAPH_TOKEN + IG_USER_ID` are set. Pick reel (left) + product/variant (right) → review → **Tag products on reel**. Verify on **Instagram mobile app** — product tags do **not** render on desktop web (`instagram.com/.../reels` shows no View Products; this is a Meta limitation, documented in-app).

## Usage

- `/` — dashboard: video cache / embedding counts, enrichment worker status, Scan existing catalog, store readiness (webMCP), webhook deliveries, enrichment outcomes, agent search FAB.
- `/connect` — Tag-a-reel workspace (reels left, products right, review table, tag action; history in `tag_events`).
- `/agent` — full chat/search over shoppable videos with PDP links.
- `/scan?shop=…` — scan progress page.
- `/mcp/{shop}` — MCP endpoint. Tools: `search_products(query, image_embedding?, price_max?)`, `get_product_details(sku)`, `get_inventory(sku)`, `get_video_summary(video_id)`. GET legacy params or POST MCP Streamable HTTP.
- `/openapi.yaml` — agent entry contract.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| `{{IE_30007}}` / `{{IE_30002}}` / `{{IE_30010}}`, "Failed to Replace Commerce Account" | Commerce Account issue — app humanizes it: catalog not approved / domain mismatch / under review → fix in Commerce Manager; use on-site widget + YouTube meanwhile |
| No View Products on reel (desktop web) | Expected — Meta only renders IG product tags in the mobile app; test on phone |
| `IG keys missing` / `IG API 4xx` on `/connect` | `META_GRAPH_TOKEN`/`IG_USER_ID` unset or expired → regenerate system-user token |
| `Shopify API 401` | Token dead → Reconnect store; readiness card shows `token: dead` + missing scopes |
| Enrichment stuck `sent` | `MODAL_WEBHOOK_URL`/secret mismatch, or product has no media → check `ingest_jobs.detail`, Modal logs |
| Verified rows overwritten | Impossible by design — upsert has `WHERE verified IS DISTINCT FROM TRUE`; release per row explicitly |

## Project structure

```
app/                  Remix app (Vercel)
  routes/             /, /connect, /agent, /scan, /mcp.$shopId, /api.*, /webhooks.*, /auth.*
  lib/                db.ts, mcp/, shopify/, video/, activation/
  tokens.css          shared r2ac styles
extensions/shoppable-video-widget/   Theme App Extension (PDP widget)
modal/enrich_video.py Modal GPU: Muse vision + embeddings → Neon (+ ingest webhook)
db/schema.sql         Neon tables + pgvector HNSW index
docs/                 PRD, checklists, scan/activation, tag visibility
shopify.app.toml      App config: scopes, webhooks, extension
```

## Cost (~$20–25/mo + inference)

Vercel Pro ($0–20) + Neon (free 0.5 GB, then ~$5) + Modal pay-per-second (~$10–15 for 500 videos) + Vercel Blob/R2 ($0). Drops Qdrant/Upstash/Fly (~$125/mo → ~$25/mo). Inference $0.10–0.15/video self-hosted, once per video, cached forever.

## Scripts

- `npm run dev` — local Remix dev
- `npm run build` — production build
- `npx tsc --noEmit` — typecheck (`npm run typecheck`)
- `python scripts/agent_demo.py` / `bulk_e2e.py` — MCP demo / bulk E2E helpers
