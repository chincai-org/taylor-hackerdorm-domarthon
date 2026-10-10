# AGENTS.md

Guide for AI coding agents (+ humans). **24h hackathon**: end-to-end > polish, small changes, no over-engineering.

## 1. Project Overview

**One AI optimizes harness of another AI**, inspired by [Petri](https://ethonline2026-two.vercel.app/) ([repo](https://github.com/Avoisavo/ethonline2026/tree/petri)).

- **Harness** = config around customer-support agent: system prompt, tool defs/descriptions, routing/policy instructions, anything shaping behavior.
- Versions stored as **tree**. Each node = one harness version + **benchmark result**.
- **Optimizer ("Workbuddy")** runs user-side, reads node (+ children) via **MCP server**, proposes improved harness, submits back as new child node.
- **Server** auto-evaluates every new node vs benchmark, stores result.
- Failures **kept** → optimizer never repeats same approach.

**Scope: customer support only.**

## 2. Core Concepts (exact terms)

| Term               | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Session / Tree** | One optimization run. Own benchmark + root node. ID = `tree_id`.                            |
| **Node**           | One harness version. `node_id`, `parent_id`, `harness`, `benchmark_result`, `status`.       |
| **Harness**        | Agent config under optimization (prompt, tool specs, policy text, etc.).                    |
| **Benchmark**      | Fixed customer-support scenarios + deterministic checks, owned by tree.                     |
| **Child nodes**    | Prior attempts incl. failures/regressions — signal, not noise.                              |
| **Workbuddy**      | Optimizer agent calling MCP tools.                                                          |
| **PI**             | Agent harness/runtime server uses for benchmark (GraffiLab AI API — confirm name/endpoint). |

## 3. Architecture

```
┌────────────────────┐        MCP         ┌──────────────────────────────┐
│ Workbuddy (user)   │ ─────────────────► │ Hosted server (FastAPI)      │
│ "Improve this node"│ ◄───────────────── │  - MCP server (python mcp)   │
└────────────────────┘                    │  - REST API for frontend     │
                                          │  - Evaluator (runs PI vs     │
┌────────────────────┐      REST/JSON     │    benchmark)                │
│ Web frontend       │ ─────────────────► │  - DB (trees, nodes, results)│
│ (Vercel)           │ ◄───────────────── └──────────────┬───────────────┘
└────────────────────┘                                   │
                                                         ▼
                                              GraffiLab AI API (PI)
```

- **Server**: stores tree, runs PI vs benchmark, stores results, exposes MCP + REST.
- **Workbuddy**: user-side. No direct DB access — MCP only.
- **Frontend**: lists sessions, tree viz, node/benchmark detail. Optional "create session".

## 4. Tech Stack

- **Backend:** Python, FastAPI, official MCP Python SDK (`mcp`) mounted alongside FastAPI.
- **Database:** SQLAlchemy models + repository helpers, Neon Postgres local + Vercel. Harnesses/scenarios/results in JSON fields; DB access behind `app/db/repository.py`.
- **Frontend:** Vercel. Tree viz (React Flow / d3 / plain SVG). Prefer already-scaffolded.
- **Eval runtime:** PI via GraffiLab AI API.

> Repo choice beats this file on conflict — then update this section.

## 5. Repository Layout

Don't restructure without reason.

```
/
├── AGENTS.md
├── app/
│   ├── main.py              # FastAPI app; mounts /trees, /showcase + REST/MCP routers
│   ├── api/                 # REST endpoints for frontend
│   ├── core/                # Settings
│   ├── db/                  # Engine, models, repository (SQLAlchemy + Neon Postgres)
│   ├── harness/             # Harness import helpers
│   ├── schemas/             # Shared Pydantic models (MCP + REST)
│   ├── services/            # PI clients, digest helpers
│   ├── mcp_server.py        # MCP tool definitions
│   └── web/                 # Everything browser sees
│       ├── templates/       # Live pages: gallery.html (/), tree-detail.html (/tree/*)
│       ├── static/          # Served at /trees: theme.css, live-viewer.css/js,
│       │                    # showcase-enhance.js
│       └── showcase/        # Static Petri showcase source (build.mjs, registry.mjs,
│           │                # lib/, templates/, data/, checks/)
│           └── dist/        # GENERATED showcase pages, served at /showcase/
├── benchmarks/              # Benchmark definitions (customer support)
├── scripts/                 # One-off helpers (DeepSeek eval)
├── tests/                   # pytest suite
└── public/                  # Vercel static assets
```

## 6. Data Model

```
Tree:   id, name, description, benchmark_id, root_node_id, status, metadata, created_at
Node:   id, tree_id, parent_id (nullable for root), harness (TEXT),
        status (pending | running | complete | failed),
        score (float), benchmark_result (JSON), rationale (text), error (JSON), created_at
Benchmark: id, name, version, scenarios (JSON), created_at
```

- Root node has seed harness, evaluated on creation.
- **Invariant:** `complete` node has harness *and* benchmark result. Workbuddy can assume it.
- One root per tree; children reference parent in same tree.
- Status ∈ `pending`, `running`, `complete`, `failed`.
- Never delete nodes — failures stay visible/queryable.
- Store `rationale` (why change) on each node → guides future attempts.

## 7. Benchmark Design (customer support)

Must be **objective + deterministic** → trustworthy scores.

Each scenario:
- Simulated customer message / conversation.
- **Expected tool calls** (e.g. `query_database`, `check_company_policy`, `lookup_order`).
- **Expected final action** (refund demand → `issue_refund`; policy violation → `deny_with_explanation`).
- Optional **forbidden actions** (e.g. refund outside policy).

Scoring:
- **Programmatic checks** (tool called? correct args? correct final action?) > LLM-as-judge.
- LLM judge unavoidable → fixed rubric, binary pass/fail, temperature 0.
- Report: overall score, per-scenario pass/fail, failure reasons. Per-scenario detail = what Workbuddy learns from.
- **Immutable once tree has nodes** — changes invalidate comparisons.
- Mocked/sandboxed scenarios: benchmark tools never touch real systems.

## 8. MCP Interface

Workbuddy flow: user gives `tree_id` + `node_id`, prompts **"Improve this node"**. Call order ≈ table order.

| Tool                                                        | Purpose                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `list_trees()`                                              | Sessions (id, name, best score, node count).                              |
| `get_tree(tree_id)`                                         | Tree summary + structure (node ids, parents, scores).                     |
| `get_node(tree_id, node_id)`                                | Harness, benchmark results (incl. per-scenario failures), rationale.      |
| `get_children(tree_id, node_id)`                            | Prior attempts: harness diffs/results/rationale.                          |
| `get_benchmark(tree_id)`                                    | Benchmark description → what gets measured.                               |
| `create_child_node(tree_id, parent_id, harness, rationale)` | Create child, trigger eval, return `node_id` + status (+ result if fast). |
| `get_node_status(tree_id, node_id)`                         | Poll eval status/result.                                                  |

Rules:
- **Concise structured JSON**. Truncate big payloads; offer drill-down.
- `get_node` / `get_children` must carry enough context → **avoid repeating failed approaches**.
- `create_child_node` validates parent exists, belongs to tree, is `complete`.
- Eval slow → async + poll, or block with sane timeout. No stuck `running`; mark `failed` on error/timeout.
- Errors clear + actionable (what wrong, what next).

## 9. Evaluation Flow (server-side)

1. `create_child_node` inserts node `status=pending`.
2. Evaluator sets `running`, runs PI + node harness vs every scenario.
3. Applies checks, writes `score` + `result`, sets `complete` (or `failed` + error).
4. Frontend + MCP read updated node.

- Cap concurrency + per-scenario timeouts → protects API quota (hackathon budget!).
- Cache only keyed by harness hash + benchmark version.
- Log raw PI transcripts per scenario (reference or truncated text in DB) → debuggable failures.
- Deterministic where possible (fixed seeds/temperature 0).

## 10. Frontend Requirements

- **Home:** sessions/trees: name, node count, best score. Optional "Create session".
- **Tree page:** visual tree; score + status per node; failed/regressed distinct but visible; highlight best.
- **Node detail:** harness, rationale, per-scenario results, parent/child links.
- Data from server REST API (base URL via env var).
- Simple + demo-ready; legibility > animation.

## 11. Development Commands

```bash
# Install/sync Python dependencies
uv sync

# Start FastAPI + MCP server locally
uv run uvicorn app.main:app --reload --port 5001

# Or run one-off DeepSeek harness eval (needs DEEPSEEK_API_KEY)
uv run python scripts/deepseek_eval.py

# Create local Neon Postgres schema
uv run python -c "from app.db import create_tables; create_tables()"

# Format and lint
uv run ruff format .
uv run ruff check .

# Run tests when test files present
uv run pytest

# Rebuild static showcase (writes app/web/showcase/dist/)
node app/web/showcase/build.mjs

# Showcase unit + render tests (pure Node, no browser)
node --test app/web/showcase/checks/unit.mjs app/web/showcase/checks/render.mjs
```

### DeepSeek agent API (prompt + harness, streamed over SSE)

- `POST /api/v1/deepseek/chat` → one JSON reply (`reply`, `tool_calls`, harness echo).
- `POST /api/v1/deepseek/stream` → same result as SSE (`curl -N` / no-buffer keeps live).
- Both take `{ prompt, harness_yml?, harness?, system_prompt?, tools?, model?, timeout? }`.
  Harness is raw `cordis.patch.yml` text in `harness` or `harness_yml`. Mutually
  exclusive; omit both → bare prompt-only.
- SSE order: first event always `{"harness": "..."}` (harness text plus metadata)
  → `{"delta"}` chunks → optional
  `{"tool_calls"}` → `{"status": "done"}` or `{"error"}`.
- Needs server-side `DEEPSEEK_API_KEY` (`GET /api/v1/deepseek/health` reports `available`;
  else chat/stream → `503`).

Example — stream one support prompt with harness file:

```bash
jq -n --arg prompt "I was charged twice for the same order." \
  --rawfile yml cordis.patch.yml \
  '{prompt: $prompt, harness_yml: $yml}' > /tmp/body.json

curl -N -X POST https://taylor-hackerdorm-domarthon-production.up.railway.app/api/v1/deepseek/stream \
  -H 'Content-Type: application/json' \
  -d @/tmp/body.json
```

`jq --rawfile yml` reads `cordis.patch.yml` as raw string into `$yml`, builds
`{prompt, harness_yml}` into `/tmp/body.json`; `curl -N` POSTs to prod host (local:
`http://127.0.0.1:5001/api/v1/deepseek/stream`). Swap `prompt` / `yml` for other
scenarios/harnesses.

Local + Vercel both use Neon Postgres. Local pooled string in `.env.development.local`;
Vercel provides own `DATABASE_URL`. Same DB code both envs, only credentials differ.

Env vars (never commit secrets; provide `.env.example`):
- `GRAFFILAB_API_KEY` (confirm name) — PI eval API
- `DATABASE_URL` — Neon Postgres URL; local via `.env.development.local`
- `NEXT_PUBLIC_API_URL` / equivalent — frontend → server base URL

## 12. Coding Conventions

- **Python:** type hints, Pydantic models for all req/resp bodies, small fns, `async` where helps (PI calls, MCP).
- **Frontend:** TypeScript preferred if already used; follow existing lint/format.
- MCP + REST schemas in sync — share Pydantic models.
- Names match §2 terms (`tree`, `node`, `harness`, `benchmark`).
- Brief docstrings on MCP tools — Workbuddy reads them to decide usage.

## 13. Do / Don't

**Do**
- Thin vertical slice first: seed tree → read via MCP → create child → evaluate → show in UI.
- Seed demo tree with handful nodes (incl. failures) → UI + MCP demoable immediately.
- Keep evaluator + DB interfaces swappable.
- Note assumptions in PR descriptions / commit messages.

**Don't**
- Workbuddy (or any client) writing DB except via MCP tools.
- Delete/overwrite nodes or results.
- Modify benchmark after its tree has nodes.
- Hardcode API keys or commit `.env`.
- Heavy infra (queues, Docker orchestration, auth) unless demo-blocked.
- Expand scope beyond customer support.

## 14. Definition of Done (hackathon demo)

- [ ] Create/seed tree with benchmark + evaluated root node.
- [ ] MCP tools read node, children, benchmark.
- [ ] `create_child_node` stores node + auto-runs PI vs benchmark.
- [ ] Workbuddy given `tree_id` + `node_id` + "Improve this node" → new child end-to-end.
- [ ] Frontend lists sessions, visualizes tree with scores + per-scenario results.
- [ ] Server reachable by Workbuddy; frontend on Vercel.
- [ ] README/demo script showing full loop.

## 15. Database Plan

- Local + prod: **Neon Postgres** via `DATABASE_URL`.
- SQLAlchemy shared layer both envs; only credentials differ.
- `trees` = sessions, `benchmarks` = immutable scenario sets, `nodes` = tree via `tree_id` + `parent_id`.
- Harnesses, scenarios, results, metadata, eval errors = JSON fields.
- `create_root_node` enforces one root/tree; `create_child_node` validates parent ∈ same tree.
- Nodes retained incl. failed/regressed. Eval updates status/score/result/error via `update_node_evaluation`.
- Schema creation via `create_tables()` locally. Add prod migrations before deploying schema changes.

### Database schema

Three tables. App generates UUIDs as 36-char strings; timestamps tz-aware, default DB `CURRENT_TIMESTAMP`.

```text
benchmarks
-----------
id          VARCHAR(36) PRIMARY KEY
name        VARCHAR(255) NOT NULL
version     INTEGER NOT NULL DEFAULT 1
scenarios   JSON NOT NULL
created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP

trees
-----
id            VARCHAR(36) PRIMARY KEY
name          VARCHAR(255) NOT NULL
description   TEXT NULL
benchmark_id  VARCHAR(36) NOT NULL REFERENCES benchmarks(id)
root_node_id  VARCHAR(36) NULL
status        VARCHAR(32) NOT NULL DEFAULT 'active'
metadata      JSON NOT NULL DEFAULT {}
created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP

nodes
-----
id                VARCHAR(36) PRIMARY KEY
tree_id           VARCHAR(36) NOT NULL REFERENCES trees(id)
parent_id         VARCHAR(36) NULL
harness           TEXT NOT NULL
status            VARCHAR(32) NOT NULL DEFAULT 'pending'
score             FLOAT NULL
benchmark_result  JSON NULL
rationale         TEXT NULL
error             JSON NULL
created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
```

Relationships/constraints:

- Tree → one immutable benchmark via `trees.benchmark_id`.
- Node → one tree via `nodes.tree_id`.
- Root: `parent_id = NULL`; child: `parent_id` = parent. No DB FK on parent — repo enforces creation/validation.
- `trees.root_node_id` nullable while tree being created.
- JSON fields: scenarios, results, tree metadata, eval errors. Harnesses are text.
- Status ∈ `pending`, `running`, `complete`, `failed`.
- `ix_nodes_tree_parent` (`tree_id`, `parent_id`) → traversal.
- `ix_nodes_tree_status` (`tree_id`, `status`) → status filter.
- `ix_nodes_tree_score` (`tree_id`, `score`) → ranking.


- Exact GraffiLab AI / PI API shape, auth, rate limits.
- Eval sync vs async-with-polling for MCP.
- "Create session" in MVP?
- MCP transport (streamable HTTP vs SSE) for hosted deploy — Vercel serverless limits may push long evals elsewhere (small VM/Fly/Railway), Vercel serving frontend only.

---

## 16. Frontend guidance — live backend viewer + standalone Petri showcase

### 16.1 Production integration (takes precedence over showcase notes)

- Live gallery `/` renders `app/web/templates/gallery.html`. Native cards → `/tree/{tree_id}`
  from `app/web/templates/tree-detail.html`. Detail fetches only `/api/v1/trees/{tree_id}` +
  native Back to trees link. FastAPI serves live-viewer assets at `/trees`, static showcase
  at `/showcase`; REST contracts unchanged.
- Keep loading/failure/retry handling on both live pages. Node selection keeps keyboard
  focus on selected link; live region announces changes.
- `app/web/static/live-viewer.js` restores integration from commit `54019be`;
  `live-viewer.css` scopes live styles to `.live-trees`. Keep both linked from prod template.
  No Node build needed to serve live page in Python container.
- Live nodes: `pending`, `running`, `complete`, `failed`; nullable raw scores, harness text,
  rationale, results, errors. Harness + result payloads have copy controls. Scenario-array
  results → passed/failed/unscored cards; summary-only → labeled facts. No raw result JSON
  in normal detail UI. Copy payload verbatim. Wide lineage SVG centered in bounded scroll
  stage. Never apply showcase acceptance thresholds / basis points / verification keys /
  Petri CLI instructions to backend data.
- Static showcase stays `/showcase/index.html` or local `file://` page.
  `showcase-enhance.js` only enhances; `build.mjs` composes static `templates/` modules.
  Never overwrite prod integration with showcase code.
- `node checks/integration.mjs` from `app/web/showcase`: read-only same-origin
  API-contract/browser tests on local fixtures, no DB. Covers clipboard payloads, scenario
  rendering, sparse-tree centering, dropdown pointer. Also run static build, unit/render,
  static checks.
- Frontend `lib/` tracked in Git. Root `.gitignore` exempts `app/web/showcase/lib/` from
  generic Python `lib/` ignore.
- Live data needs JS (as recovered commit). No-JS prod shell links JSON API/docs instead of
  fictional showcase data. Strict no-JS rules below = standalone showcase only.

---

### 16.2 Standalone showcase notes

Read first before changing showcase. **Traps** section matters most: every entry = bug that
already happened once, easy to reintroduce.

---

#### 16.2.1 What this is

**Standalone plain HTML/CSS/JS recreation** of Petri "Trees" section. No framework/bundler/runtime deps.

Source: `app/web/showcase/`; build output: `app/web/showcase/dist/` (served `/showcase/`,
opens `file://`). Move deliverable → move this guidance too + fix paths in §16.2.3/§16.2.4
(`checks/` scripts contain absolute paths).

|                          |                                                               |
| ------------------------ | ------------------------------------------------------------- |
| Reference repo (Next.js) | `ref/` — clone of `https://github.com/Avoisavo/ethonline2026` |
| Live reference           | `https://ethonline2026-two.vercel.app/`                       |
| Deliverable              | `app/web/showcase/` (source) → `dist/` (generated pages)      |
| Screenshots              | `shots/`                                                      |
| Work log                 | `.workbuddy-ai/memory/2026-10-10.md` (history of *why*)       |

`ref/` = **read-only source of truth for behaviour/geometry**. Never edit. Reference usually
wins on disagreement — except deliberate divergences in §16.2.6.

---

#### 16.2.2 Non-negotiable constraints

1. **Works with JS disabled.** Headline req, easiest to break. Read §16.2.5 before touching
   anything interactive.
2. **No dependencies.** No npm/framework/bundler/CDN. Build = `node build.mjs`, Node stdlib only.
3. **Opens from `file://`.** No server. All pages in one flat `dist/` → stylesheet/script/links
   plain siblings.
4. **Static HTML, generated at build time.** Complete + readable before any script runs.
5. **Visually faithful to reference**, except deliberate divergences (§16.2.6).

---

#### 16.2.3 Layout

```
app/web/showcase/
  build.mjs                 THE GENERATOR. Emits dist/ pages + per-tree stylesheets.
  registry.mjs              Tree registry: TREES[] + loadTree(). Showcase or real snapshot.
  lib/
    layout.mjs              buildForest / tidySlots — port of ref/lib/layout.ts
    glyph.mjs               Per-node status glyph (port of ref/components/Glyph.tsx)
    metrics.mjs             changesOf / fmtPct
    format.mjs              Status words, basis points, node numbers, claim/sign helpers
    objectives.mjs          OBJECTIVES — fork "direction" options
  data/
    showcase.mjs            5 hand-authored trees (port of ref/lib/showcase.ts)
    petri-export.json       Real `petri export` snapshot (1 tree)
    petri-digest.json       Its digest panel
  checks/                   Verification suite (§16.2.4.2).
  dist/                     GENERATED — gallery, 6 tree pages + stylesheets,
                            + copies of theme.css / showcase-enhance.js (file:// needs
                            no server).
```

Shared `theme.css` + `showcase-enhance.js` live in `app/web/static/` (also served to live
viewer at `/trees/`); `build.mjs` copies both into `dist/` every build.

Six slugs: `research--hermes-agent--claude-sonnet-5`,
`coding--claude-code--claude-opus-5`, `coding--petri-harness-v1--claude-sonnet-5`,
`finance--pi--claude-haiku-4-5`, `security--codex-cli--gpt-5`,
`data-analysis--openhands--gemini-2-5-pro`.

**Never hand-edit `dist/`.** Gallery/tree pages/stylesheets overwritten every build.
`<slug>.css` header says so. Edit `build.mjs`, `theme.css`, `showcase-enhance.js` or
`data/`, then rebuild.

---

#### 16.2.4 Commands

##### 16.2.4.1 Build

```bash
cd app/web/showcase
node build.mjs
```

Expected: `Wrote dist/index.html, 6 tree pages (…) and 6 tree stylesheets (…).` Byte counts
drift with content — only message shape matters.

No `node` on PATH → managed runtime (`node` v22 under the Workbuddy binaries dir).

##### 16.2.4.2 Checks

Playwright = dev tool, **not** deliverable dep. Already installed under the
Workbuddy-managed Node workspace (`playwright-core`).
Scripts resolve it via `createRequire` there.

```bash
cd app/web/showcase/checks
node verify.mjs        # contrast, font sizes, tap targets; then JS-on interaction path
node nojs.mjs          # THE HEADLINE CHECK — same interactions, JS disabled
node sweep.mjs         # 7 pages × 9 widths (360…1920): overflow, escaped elements, sticky overlap
node palette.mjs       # resolved colour of every semantic element; flags non-blue hue
node clipboard.mjs     # clipboard really gets command; icon swaps
node copy-fallback.mjs # no-navigator.clipboard path + glyph draws
node cmd-box.mjs       # copy control geometry inside command box; no word split
node shots.mjs         # regenerates ../shots/
```

**Caveat — read output, not exit code.** Only `cmd-box.mjs` calls `process.exit(1)` on
failure. Others print failures yet exit `0`. Zero exit ≠ pass.

##### 16.2.4.3 Definition of done

Layout/CSS/markup change → all green:

| Check               | Expected                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `verify.mjs`        | `contrast 0`, `<12px 0`, `tap<24 0` all three pages; selection/chips/switch correct            |
| `nojs.mjs`          | node click, narrow list-row click, "Full record" all swap strip **and** panel; 6 gallery links |
| `sweep.mjs`         | `0 failing viewport/page combinations out of 63`                                               |
| `palette.mjs`       | `All non-failure chrome sits in the blue family.`                                              |
| `clipboard.mjs`     | clipboard matches `data-copy`; `0 copy buttons rendered with no script`                        |
| `copy-fallback.mjs` | tick shown via fallback; glyph drawn 16×16                                                     |
| `cmd-box.mjs`       | `0 failure(s)`                                                                                 |

---

#### 16.2.5 The four mechanisms

Required reading before touching anything interactive. Makes JS-off work.

##### 16.2.5.1 Layout solved at build time

Tidy-tree row layout depends on leaves above each node. `lib/layout.mjs` computes in Node;
pages ship complete static SVG. Browser never computes geometry. **Node added / shape
changed → rebuild, never fix layout in CSS/JS.**

##### 16.2.5.2 State lives in CSS

Tree|Stats switch + four info chips = **native radio groups** (`<input>` + `<label>`),
shown/hidden via `body:has(#id:checked)`. No JS; arrow keys native. Never convert to
buttons or add JS.

##### 16.2.5.3 Selection: two paths, one outcome

Two ways to decide shown version, must never fight:

- **No script** — figure links `#s-<short>`, generated `<slug>.css` uses `:target`.
- **With script** — `showcase-enhance.js` adds `is-open` to `.selected-strip` (`:target`
  **not** re-evaluated when fragment rewritten in place — see Trap 1).

Generated rules cover both; `:target` half disables itself once strip marked:

```css
:is(body:not(:has(.selected-strip.is-open)):has(#s-he-07:target),
    body:has(.selected-strip.is-open):has(.selected-strip[data-for="he-07"].is-open))
```

Mechanism = **custom properties**, not declarations — one rule covers wide figure + narrow
list, another covers strip + record. `theme.css` defaults (`--sel-ring` → `none`) → unchosen
version costs nothing.

##### 16.2.5.4 Progressive-enhancement gate

Script-only controls carry `.needs-js`, **hidden until script runs**:

```css
.needs-js { display: none; }                    /* not display:none in the markup */
html.has-js .icon-btn.needs-js { display: inline-flex; }
```

`showcase-enhance.js` adds `html.has-js` first. Script never loads → copy buttons + direction
picker absent, never shown-but-inert. Commands stay readable plain text. **Never add
interactive-looking control needing JS without this gate.**

---

#### 16.2.6 Deliberate divergences from reference

**Intentional.** Never "fix" back without asking.

| Area               | Ours                                                                          | Reference                                                                    |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Colour             | M3 dark seeded from **blue**                                                  | M3 baseline purple (`#6750A4`)                                               |
| `tertiary`         | cyan (`#a2d2df`)                                                              | M3 pink                                                                      |
| `.record-info`     | `position: sticky`                                                            | static (leaves tall void)                                                    |
| `.chips`           | bare M3 filter-chip group, 32px, gap 8                                        | nested sunk panel, 34px, gap 4                                               |
| Radii              | 8px / 12px (`--shape-sm` etc.)                                                | fixed 10px                                                                   |
| Copy control       | 32px **icon button** with clipboard glyph, **inside** command box both blocks | text "Copy"; inside in `.checkit-cmd`, **below** command in `.np-block.fork` |
| `build.mjs` output | flat folder (`index.html`, `<slug>.html`)                                     | Next.js routes                                                               |

**Copy placement** stands out: reference itself inconsistent (table above). Ours inside both
places. Cost: button eats ~34px command width (300 → 266px) → pushes fork command to wrap
at sidebar widths.

---

#### 16.2.7 Traps

Each: symptom → cause → working fix.

##### 16.2.7.1 `:target` not re-evaluated by `history.replaceState()`

**Symptom.** Node click changes URL, screen static.
**Cause.** Selection drove off `:target` + only `replaceState`. In-place fragment rewrite
never re-resolves `:target`.
**Fix.** `showcase-enhance.js` selects via `is-open` class; fragment kept only for shareable
URL (§16.2.5.3).
**Trap.** One-off test *seems* to prove `replaceState` works if fragment set during initial
script run — target just computed first time before first style resolution. Test the click,
not the load.

##### 16.2.7.2 One fragment can't mean two things

**Symptom (JS off).** "Full record ↓" resets page to default version.
**Cause.** Strip held `id="s-<short>"`, figure linked it, but "Full record" → `#record`
matches no `#s-*:target` rule → all strips collapse.
**Fix.** `s-<short>` id lives on **record `<article class="rec">`** → one fragment selects
version + scrolls to it. `showcase-enhance.js` keys off `strip.dataset.for`, not `strip.id`;
"Full record" plain anchor, no `preventDefault`. `.rec` has `scroll-margin-block-start: 64px`
(clears top bar). Empty-choice test = `body:not(:has(.rec:target))` — **not**
`.selected-strip:target`.

##### 16.2.7.3 `data-fork-out` stays on `<pre>`

**Symptom.** Fork copy button vanishes on first direction-picker change.
**Cause.** `showcase-enhance.js` does `out.textContent = …` → **replaces every child**.
Attribute on wrapper → button (child) deleted.
**Fix.** `data-fork-out` on `<pre>`, button its *sibling*. `checks/cmd-box.mjs` asserts both.

##### 16.2.7.4 Copy button = sibling, never child

Same root as 16.2.7.3: **never nest copy button inside copied element.** Hooks: `data-copy`
(literal string) + `data-copy-out` (reads `[data-fork-out]`).

##### 16.2.7.5 Chromium reports `fill` as `rgb(0, 0, 0)` for HTML elements

**Symptom.** Colour probe reports black for every link.
**Cause.** HTML-element `fill` = meaningless `rgb(0, 0, 0)` — *not* `none`. "Fallback to
`color` when `fill` none" probe silently reports black.
**Fix.** Name CSS channel per element in `checks/palette.mjs` (`PROBES`).

##### 16.2.7.6 Playwright forces light mode

Pages dark-only. Pass `colorScheme: "dark"` to context, else screenshots/measurements wrong.

##### 16.2.7.7 `waitUntil: "load"` never settles on `file://` with scripting off

Use `{ waitUntil: "domcontentloaded" }` in `javaScriptEnabled: false` context.

##### 16.2.7.8 Chromium normalises clipboard newlines to CRLF

Clipboard-vs-`<pre>` comparison fails `\n` vs `\r\n`. Normalise before comparing.

##### 16.2.7.9 Unscoped selectors match hidden records

**Symptom.** Geometry assertion passes when should fail, or readability check `false`.
**Cause.** Every record ships own fork block/check-it/panels, only one displayed.
`document.querySelector(".fork .cmd")` returns **first** → hidden record, measures **0×0** —
0×0 satisfies every containment test free.
**Fix.** Scope to visible record: `.rec[data-for="he-08"]`. `checks/cmd-box.mjs` also asserts
non-zero box → vacuous pass impossible.

##### 16.2.7.10 Edge reports `file://` as secure context

**Symptom.** `execCommand` fallback never exercised locally.
**Cause.** `navigator.clipboard` present even on `file://` in Edge → fallback never runs.
**Fix.** `checks/copy-fallback.mjs` deletes `navigator.clipboard` before load → forces fallback.
Fallback ≠ dead code — only route in genuinely insecure context.

##### 16.2.7.11 Figure SVG text in user units

`.h-word`, `.h-num`, objective labels inside SVG viewBox; build derives label boxes from char
counts. **Resizing desyncs geometry.** Sub-12px rule = HTML labels only.

##### 16.2.7.12 `--flag` can break after hyphen

**Symptom.** Command renders `--` line-end + `area` next-line-start.
**Cause.** Hyphen = legit CSS break opportunity.
**Fix.** None in CSS. `word-break: keep-all`, `line-break: strict`, `break-spaces`,
`overflow-wrap: anywhere` all measured, break same place. Only per-token markup stops it.
`checks/cmd-box.mjs` reports as `note`, not failure. Soft wrap inserts **zero chars** →
clipboard payload unaffected.

##### 16.2.7.13 `overflow-wrap: break-word` splits words mid-token

Token breaks at overflow point — `improves` → `improv` / `es`. Use `overflow-wrap: normal`
→ breaks only at real opportunities.

**Trap-in-trap:** at real content widths `break-word` ≡ `normal` rendering, so "no mid-word
break" test passes under both, proves nothing. Assertion meaningful only with synthetic
over-long token. Test that can never go red ≠ evidence.

##### 16.2.7.14 `@layer` order load-bearing

`@layer tokens, base, layout, card, glyph, page, motion;` → stylesheet needs no `!important`.
New rules → correct layer. `.checkit-cmd` in `page` after `.cmd`, relies on source order for
its one extra declaration.

##### 16.2.7.15 Tap targets need real padding

`::after` pseudo hit-area tried + **reverted**: `elementsFromPoint` proves no hit-area
extension, tooling can't measure. Use real `padding-block`.

##### 16.2.7.16 Never hand-edit generated CSS/HTML

`<slug>.css` carries GENERATED header. Edit `selectionCss()` in `build.mjs`, rebuild.

---

#### 16.2.8 Conventions

- **Comments explain *why*, not what.** Odd-looking rule usually has reason beside it — read
  first. Several name measured-and-rejected alternative.
- **Escape every interpolation** in `build.mjs` with `esc()`.
- **No raw colour outside `@layer tokens`.** M3 roles (`--md-sys-color-*`), `--md-state-*`
  state layers, `--shape-*` radii, `--type-*` type. Non-M3 value → say so in comment.
- **Additive JS only.** `showcase-enhance.js` never loads → pages still work. Anything else →
  `.needs-js` gate.
- **One shared rule > two near-identical.** Two command blocks share `.cmd`; strip/record
  reveals share generated `--sel-*` props.
- **Delete dead CSS.** No unused-class linter in `checks/` → grep stylesheet vs generated markup
  before assuming class needed. (Earlier `check.mjs` did this, now gone — reinstate if dead
  CSS recurs.)

---

#### 16.2.9 Do not

- Dependency / framework / bundler / CDN script.
- Build step beyond `node build.mjs`.
- Move page out of `dist/`. Preview harness maps each dir to own base path →
  `index.html` vs `tree/*.html` different bases → every card link 404s. All generated pages
  stay in one flat `dist/`.
- Hand-edit anything under `dist/`.
- Edit anything in `ref/`.
- Convert radio-group switch/chips to JS.
- Interactive-looking control without `.needs-js` gate.
- Trust green test without checking it goes red (see 16.2.7.13).
- Claim layout done without `sweep.mjs` — 63 viewport/page combos = only narrow-width net.

---

#### 16.2.10 Matching reference more closely

1. Measure, never eyeball. Render live site via Playwright at same viewport
   (`colorScheme: "dark"`), compare **computed box models**.
2. Compare DOM, not just pixels. Past "switch must be fragment-driven" assumption wrong —
   `ref/components/Panels.tsx` showed React buttons with `aria-pressed`, no anchors; change
   reverted.
3. Check §16.2.6 first — difference may be deliberate.
4. After change → full suite (§16.2.4.3).
