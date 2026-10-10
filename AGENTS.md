# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.
This is a **24-hour hackathon project**: favor working end-to-end over polish, keep changes small, and don't over-engineer.

## 1. Project Overview

We are building a system where **one AI optimizes the harness of another AI**, inspired by [Petri](https://ethonline2026-two.vercel.app/) ([repo](https://github.com/Avoisavo/ethonline2026/tree/petri)).

- A **harness** is the configuration wrapped around a customer-support agent: system prompt, tool definitions/descriptions, routing/policy instructions, and any other settings that shape its behavior.
- Harness versions are stored as a **tree**. Each node = one harness version + its **benchmark result**.
- A **optimizer agent ("Workbuddy")** runs on the user's side, reads a node (and its children) through an **MCP server**, proposes an improved harness, and submits it back as a new child node.
- The **server** automatically evaluates every new node against the benchmark and stores the result.
- Failed attempts are **kept** in the tree so the optimizer never repeats the same approach.

**Scope: one use case only — customer support.**

## 2. Core Concepts (use these terms consistently)

| Term | Meaning |
|---|---|
| **Session / Tree** | One optimization run. Has its own benchmark and a root node. Identified by `tree_id`. |
| **Node** | One harness version. Has `node_id`, `parent_id`, `harness`, `benchmark_result`, `status`. |
| **Harness** | The agent configuration being optimized (prompt, tool specs, policy text, etc.). |
| **Benchmark** | A fixed set of customer-support scenarios + deterministic checks, owned by a tree. |
| **Child nodes** | Prior attempts to improve a node. Includes failures/regressions — they are signal, not noise. |
| **Workbuddy** | The optimizer agent on the user side that calls MCP tools. |
| **PI** | The agent harness/runtime the server uses to execute the benchmark (via the GraffiLab AI API — confirm exact name/endpoint with the team). |

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

### Responsibilities

- **Server** stores the tree, runs PI against the benchmark, stores results, and exposes both MCP and REST.
- **Workbuddy** lives on the user side. It does *not* touch the DB directly — only via MCP.
- **Frontend** lists sessions, shows a tree visualization, and node/benchmark detail. Optionally supports "create new session".

## 4. Tech Stack

- **Backend:** Python, FastAPI, official MCP Python SDK (`mcp`) mounted alongside FastAPI.
- **Database:** SQLAlchemy models and repository helpers backed by Neon Postgres in both local development and Vercel. Store harnesses, benchmark scenarios, and results in JSON fields; keep DB access behind `app/db/repository.py`.
- **Frontend:** hosted on **Vercel**. Tree visualization (e.g., React Flow / d3 / simple SVG). Prefer whatever the team already scaffolded.
- **Evaluation runtime:** PI via the GraffiLab AI API.

> If the repo already contains a framework choice that conflicts with this file, follow the repo and update this section.

## 5. Suggested Repository Layout

Adjust to match what actually exists; don't restructure without reason.

```
/
├── AGENTS.md
├── app/
│   ├── main.py              # FastAPI app; mounts /trees, /showcase + REST/MCP routers
│   ├── api/                 # REST endpoints for the frontend
│   ├── core/                # Settings
│   ├── db/                  # Engine, models, repository (SQLAlchemy + Neon Postgres)
│   ├── harness/             # Harness import helpers
│   ├── schemas/             # Shared Pydantic models (MCP + REST)
│   ├── services/            # PI clients, digest helpers
│   ├── mcp_server.py        # MCP tool definitions
│   └── web/                 # Everything the browser sees
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

## 6. Data Model (starting point)

```
Tree:   id, name, description, benchmark_id, root_node_id, status, metadata, created_at
Node:   id, tree_id, parent_id (nullable for root), harness (JSON/text),
        status (pending | running | complete | failed),
        score (float), benchmark_result (JSON), rationale (text), error (JSON), created_at
Benchmark: id, name, version, scenarios (JSON), created_at
```

- The **root node** of every tree has a seed harness and is evaluated on creation.
- **Invariant:** any node that is `complete` has a harness *and* a benchmark result. Workbuddy can assume this when reading.
- A tree has exactly one root node; child nodes must reference a parent in the same tree.
- Node status values are `pending`, `running`, `complete`, and `failed`.
- Never delete nodes — failed/low-scoring nodes remain visible and queryable.
- Store `rationale` (why Workbuddy made this change) on each node; it helps future attempts.

## 7. Benchmark Design (customer support)

The benchmark must be **as objective and deterministic as possible** so scores are trustworthy.

Each scenario consists of:
- A simulated customer message / conversation.
- **Expected tool calls** (e.g., `query_database`, `check_company_policy`, `lookup_order`).
- **Expected final action** (e.g., customer demands refund → `issue_refund`; policy-violating request → `deny_with_explanation`).
- Optional **forbidden actions** (e.g., issuing a refund outside policy).

Scoring guidelines:
- Prefer **programmatic checks** (tool called? correct arguments? correct final action?) over LLM-as-judge.
- If an LLM judge is unavoidable, use a fixed rubric, binary pass/fail items, and temperature 0.
- Report: overall score, per-scenario pass/fail, and failure reasons. Per-scenario detail is what Workbuddy learns from.
- Benchmarks are **immutable once a tree has nodes** — changing them invalidates comparisons.
- Keep scenarios mocked/sandboxed: tools in the benchmark must not touch real systems.

## 8. MCP Interface

Workbuddy's workflow: user supplies `tree_id` and `node_id`, then prompts **"Improve this node"**. Workbuddy should call tools in roughly this order.

Proposed tools (names may be adjusted; keep them small and self-describing):

| Tool | Purpose |
|---|---|
| `list_trees()` | List sessions (id, name, best score, node count). |
| `get_tree(tree_id)` | Tree summary + structure (node ids, parents, scores). |
| `get_node(tree_id, node_id)` | Harness, benchmark results (incl. per-scenario failures), rationale. |
| `get_children(tree_id, node_id)` | Prior attempts from this node with their harness diffs/results/rationale. |
| `get_benchmark(tree_id)` | Benchmark description so the optimizer understands what's measured. |
| `create_child_node(tree_id, parent_id, harness, rationale)` | Create a child, trigger evaluation, return the new `node_id` + status (and result if fast enough). |
| `get_node_status(tree_id, node_id)` | Poll evaluation status/result. |

Rules for MCP tools:
- Return **concise, structured JSON**. Truncate large payloads; offer drill-down instead.
- Include enough context in `get_node` / `get_children` for the optimizer to **avoid repeating failed approaches**.
- `create_child_node` must validate the parent exists, belongs to the tree, and is `complete`.
- Evaluation may take time — either run async and have Workbuddy poll, or block with a sensible timeout. Don't leave nodes stuck in `running`; mark `failed` on error/timeout.
- Tool errors should be clear and actionable (what was wrong, what to do).

## 9. Evaluation Flow (server-side)

1. `create_child_node` inserts a node with `status=pending`.
2. Evaluator picks it up, sets `running`, runs PI with the node's harness against every benchmark scenario.
3. Evaluator applies checks, writes `score` + `result`, sets `complete` (or `failed` with error info).
4. Frontend and MCP both read the updated node.

Guidelines:
- Cap concurrency and per-scenario timeouts to protect API quota (hackathon budget!).
- Cache nothing across harness versions unless keyed by harness hash + benchmark version.
- Log raw PI transcripts per scenario so failures are debuggable (store reference or truncated text in DB).
- Keep the evaluator deterministic where possible (fixed seeds/temperature 0).

## 10. Frontend Requirements

- **Home:** list of sessions/trees with name, node count, best score. Optional "Create session" form.
- **Tree page:** visual tree; nodes show score and status; failed/regressed nodes are visibly distinct but not hidden; highlight best node.
- **Node detail:** harness, rationale, per-scenario benchmark results, parent/child links.
- Read data from the server's REST API (configurable base URL via env var).
- Keep it simple and demo-ready; legibility beats animation.

## 11. Development Commands

```bash
# Install/sync Python dependencies
uv sync

# Start the FastAPI + MCP server locally
uv run uvicorn app.main:app --reload --port 5001

# Or run the one-off DeepSeek harness eval (needs DEEPSEEK_API_KEY)
uv run python scripts/deepseek_eval.py

# Create the local Neon Postgres schema
uv run python -c "from app.db import create_tables; create_tables()"

# Format and lint
uv run ruff format .
uv run ruff check .

# Run tests when test files are present
uv run pytest

# Rebuild the static showcase (writes app/web/showcase/dist/)
node app/web/showcase/build.mjs

# Showcase unit + render tests (pure Node, no browser needed)
node --test app/web/showcase/checks/unit.mjs app/web/showcase/checks/render.mjs
```

Local development and Vercel production both use Neon Postgres. Put the local
pooled connection string in `.env.development.local`; Vercel provides its own
`DATABASE_URL` value in the deployment environment. The application uses the
same database code in both environments and only the credentials differ.

Environment variables (never commit secrets; provide `.env.example`):
- `GRAFFILAB_API_KEY` (confirm name) — PI evaluation API
- `DATABASE_URL` — Neon Postgres connection URL; loaded from `.env.development.local` locally
- `NEXT_PUBLIC_API_URL` / equivalent — frontend → server base URL

## 12. Coding Conventions

- **Python:** type hints, Pydantic models for all request/response bodies, small functions, `async` where it helps (PI calls, MCP).
- **Frontend:** TypeScript preferred if already in use; follow existing lint/format config.
- Keep MCP tool schemas and REST schemas in sync — share Pydantic models.
- Prefer clear names matching Section 2 terminology (`tree`, `node`, `harness`, `benchmark`).
- Add brief docstrings to MCP tools — they are what Workbuddy reads to decide how to use them.

## 13. Do / Don't

**Do**
- Ship a thin vertical slice first: seed tree → read via MCP → create child → evaluate → show in UI.
- Seed a demo tree with a handful of nodes (including failures) so the UI and MCP are demoable immediately.
- Keep the evaluator and DB interfaces swappable.
- Note any assumptions in PR descriptions / commit messages.

**Don't**
- Don't let Workbuddy (or any client) write to the DB except through the MCP tools.
- Don't delete or overwrite existing nodes or their results.
- Don't modify a benchmark after nodes exist for its tree.
- Don't hardcode API keys or commit `.env`.
- Don't add heavy infrastructure (queues, Docker orchestration, auth systems) unless strictly needed for the demo.
- Don't expand scope beyond customer support.

## 14. Definition of Done (for the hackathon demo)

- [ ] Can create/seed a tree with a benchmark and an evaluated root node.
- [ ] MCP server exposes tools to read a node, its children, and the benchmark.
- [ ] `create_child_node` stores the node and automatically runs PI against the benchmark.
- [ ] Workbuddy, given `tree_id` + `node_id` and "Improve this node", can produce a new child end-to-end.
- [ ] Frontend lists sessions and visualizes a tree with scores and per-scenario results.
- [ ] Server deployed/reachable by Workbuddy; frontend deployed on Vercel.
- [ ] README/demo script showing the full loop.

## 15. Database Plan

- Local development and production use **Neon Postgres** through `DATABASE_URL`.
- SQLAlchemy is the shared database layer in both environments; only the connection credentials differ.
- `trees` store optimization sessions, `benchmarks` store immutable scenario sets, and `nodes` store the general tree using `tree_id` plus `parent_id`.
- Harnesses, benchmark scenarios, benchmark results, metadata, and evaluation errors are JSON fields.
- `create_root_node` enforces one root per tree; `create_child_node` validates that the parent belongs to the requested tree.
- Nodes are retained, including failed and regressed attempts. Evaluation updates status, score, result, and error through `update_node_evaluation`.
- Database schema creation is exposed through `create_tables()` for local setup. Production migrations should be added before schema changes are deployed.

### Database schema

The schema currently contains three tables. The application generates UUID
values as 36-character strings; timestamps are timezone-aware and default to
the database server's current time.

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
harness           JSON NOT NULL
status            VARCHAR(32) NOT NULL DEFAULT 'pending'
score             FLOAT NULL
benchmark_result  JSON NULL
rationale         TEXT NULL
error             JSON NULL
created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
```

Relationships and constraints:

- Each tree references one immutable benchmark through `trees.benchmark_id`.
- Each node belongs to one tree through `nodes.tree_id`.
- A root node has `parent_id = NULL`; a child node stores its parent in
  `parent_id`. The parent column is not a database foreign key because tree
  creation and parent validation are enforced by the repository.
- `trees.root_node_id` identifies the tree's root node and may be null while a
  tree is being created.
- JSON fields contain benchmark scenarios, harness definitions, benchmark
  results, tree metadata, and evaluation errors.
- Expected node statuses are `pending`, `running`, `complete`, and `failed`.
- `ix_nodes_tree_parent` indexes `(tree_id, parent_id)` for tree traversal.
- `ix_nodes_tree_status` indexes `(tree_id, status)` for status filtering.
- `ix_nodes_tree_score` indexes `(tree_id, score)` for ranking nodes.


- Exact GraffiLab AI / PI API shape, auth, and rate limits.
- Whether evaluation is synchronous or async-with-polling for MCP.
- Whether "Create session" is in the MVP.
- MCP transport (streamable HTTP vs SSE) for the hosted deployment — note Vercel's serverless limits may make long-running evaluation better hosted elsewhere (e.g., a small VM/Fly/Railway) with Vercel serving only the frontend.

---

## 16. Frontend guidance — live backend viewer and standalone Petri showcase

### 16.1 Production integration (takes precedence over the showcase notes below)

- The live gallery is `/`, rendered from `app/web/templates/gallery.html`. Native cards
  navigate to `/tree/{tree_id}`, rendered from `app/web/templates/tree-detail.html`. The
  detail page fetches only `/api/v1/trees/{tree_id}` and has a native Back to trees
  link. FastAPI serves live-viewer assets under `/trees` and the static showcase
  under `/showcase`; REST contracts are unchanged.
- Keep loading, failure and retry handling on both live pages. Node selection
  retains keyboard focus on the selected link; the live region announces changes.
- `app/web/static/live-viewer.js` restores the integration from commit
  `54019be`; `live-viewer.css` scopes the live viewer's styles to `.live-trees`.
  Keep both assets linked from the production template. No Node build is required
  to serve the live page in the existing Python container.
- Live nodes use `pending`, `running`, `complete`, and `failed`, with nullable
  raw scores, harness JSON, rationale, benchmark results and errors. Harness and
  result payloads have copy controls. Scenario-array benchmark results render as
  passed/failed/unscored cards; summary-only results render as labeled facts.
  Do not show raw result JSON in the normal detail UI. Keep copy payload verbatim.
  The wide lineage SVG is centered in a bounded scroll stage. Do not apply the
  static showcase's acceptance thresholds, basis points, verification keys, or
  Petri CLI instructions to backend data.
- The static showcase remains `/showcase/index.html` or a local `file://` page.
  `showcase-enhance.js` only enhances it; `build.mjs` composes the static `templates/` modules.
  Never overwrite production integration with standalone showcase code.
- Run `node checks/integration.mjs` from `app/web/showcase` for read-only
  same-origin API-contract/browser tests using local fixtures, without database
  access. It covers clipboard payloads, scenario result rendering, sparse-tree
  centering and dropdown pointer behavior. Also run the static build, unit/render
  tests and static checks.
- Frontend `lib/` modules must be tracked in Git. The root `.gitignore` explicitly
  exempts `app/web/showcase/lib/` from the generic Python `lib/` ignore rule.
- Production's live data requires JavaScript, as in the recovered commit. The
  no-JavaScript production shell links to the JSON API/docs instead of showing
  fictional showcase data. The strict no-JavaScript requirements below apply to
  the standalone showcase only.

---

### 16.2 Standalone showcase notes

Instructions for any AI agent asked to change this project. Read this file first. The
**Traps** section is the important one: every entry there is a bug that has already
happened once, and each one is easy to reintroduce.

---

#### 16.2.1 What this is

A **standalone, plain HTML/CSS/JS recreation** of the "Trees" section of an app called
Petri. No framework, no bundler, no runtime dependencies.

The showcase source lives under `app/web/showcase/`; its build output lives in
`app/web/showcase/dist/` (served at `/showcase/`, also opens from `file://`).
If you move the deliverable somewhere else, move this file with it and fix the
paths in §16.2.3 and §16.2.4 — the `checks/` scripts contain absolute paths and
will need them updated too.

| | |
|---|---|
| Reference repo (Next.js) | `ref/` — a clone of `https://github.com/Avoisavo/ethonline2026` |
| Live reference | `https://ethonline2026-two.vercel.app/` |
| Deliverable | `app/web/showcase/` (source) → `dist/` (generated pages) |
| Screenshots | `shots/` |
| Work log | `.workbuddy-ai/memory/2026-10-10.md` (read this for the history of *why*) |

`ref/` is a **read-only source of truth for behaviour and geometry**. Never edit it. When
the reference and this recreation disagree, the reference usually wins — but see
§16.2.6 for the places where diverging was a deliberate decision.

---

#### 16.2.2 Non-negotiable constraints

1. **Everything must work with JavaScript disabled.** This is the headline requirement and
   the one most likely to be broken by a careless change. Read §16.2.5 before touching anything
   interactive.
2. **No dependencies.** No npm packages, no framework, no bundler, no CDN script. The
   build step is `node build.mjs` using Node's standard library only.
3. **The output opens from `file://`.** No server required. Every page is written into
   the one flat `dist/` folder so the stylesheet, the script and the cross-page links
   are plain siblings.
4. **Static HTML, generated at build time.** Pages must be complete and readable before any
   script runs.
5. **Visually faithful to the reference**, except for the deliberate divergences in §16.2.6.

---

#### 16.2.3 Layout

```
app/web/showcase/
  build.mjs                 THE GENERATOR. Emits dist/ pages and per-tree stylesheets.
  registry.mjs              Tree registry: TREES[] + loadTree(). Showcase or real snapshot.
  lib/
    layout.mjs              buildForest / tidySlots — port of ref/lib/layout.ts
    glyph.mjs               The per-node status glyph (port of ref/components/Glyph.tsx)
    metrics.mjs             changesOf / fmtPct
    format.mjs              Status words, basis points, node numbers, claim/sign helpers
    objectives.mjs          OBJECTIVES — the fork "direction" options
  data/
    showcase.mjs            5 hand-authored trees (port of ref/lib/showcase.ts)
    petri-export.json       Real `petri export` snapshot (1 tree)
    petri-digest.json       Its digest panel
  checks/                   The verification suite. See §16.2.4.2.
  dist/                     GENERATED — gallery, 6 tree pages + stylesheets,
                            plus copies of theme.css / showcase-enhance.js so the
                            showcase opens from file:// with no server.
```

The shared `theme.css` and `showcase-enhance.js` live in `app/web/static/`
(also served to the live viewer at `/trees/`); `build.mjs` copies them into
`dist/` on every build.

The six slugs: `research--hermes-agent--claude-sonnet-5`,
`coding--claude-code--claude-opus-5`, `coding--petri-harness-v1--claude-sonnet-5`,
`finance--pi--claude-haiku-4-5`, `security--codex-cli--gpt-5`,
`data-analysis--openhands--gemini-2-5-pro`.

**Never hand-edit anything under `dist/`.** Gallery, tree pages and stylesheets
are overwritten on every build. The `<slug>.css` files say so in a header comment. Edit
`build.mjs`, `theme.css`, `showcase-enhance.js` or `data/`, then rebuild.

---

#### 16.2.4 Commands

##### 16.2.4.1 Build

```bash
cd app/web/showcase
node build.mjs
```

Expected: `Wrote dist/index.html, 6 tree pages (…) and 6 tree stylesheets (…).` The byte counts
move as content changes — only the shape of the message matters.

Plain `node` is fine if it is on PATH. Otherwise use the managed runtime:
`C:/Users/liewjayyong/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`

##### 16.2.4.2 Checks

Playwright is **not** a dependency of the deliverable — it is a dev tool, already installed
at `C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core`.
The scripts resolve it via `createRequire` against that path.

```bash
cd app/web/showcase/checks
node verify.mjs        # contrast, font sizes, tap targets; then the JS-on interaction path
node nojs.mjs          # THE HEADLINE CHECK — the same interactions with JavaScript disabled
node sweep.mjs         # 7 pages × 9 widths (360…1920): overflow, escaped elements, sticky overlap
node palette.mjs       # resolved colour of every semantic element; flags any non-blue hue
node clipboard.mjs     # the clipboard really receives the command; the icon swaps
node copy-fallback.mjs # the no-navigator.clipboard path, and that the glyph actually draws
node cmd-box.mjs       # copy control geometry inside the command box; no word split
node shots.mjs         # regenerates ../shots/
```

**Caveat — read the output, not just the exit code.** Only `cmd-box.mjs` calls
`process.exit(1)` on failure. The others print failures and still exit `0`. Do not treat a
zero exit as a pass.

##### 16.2.4.3 Definition of done

Any change to layout, CSS or markup must end with all of these green:

| Check | Expected |
|---|---|
| `verify.mjs` | `contrast 0`, `<12px 0`, `tap<24 0` on all three pages; selection/chips/switch correct |
| `nojs.mjs` | node click, narrow list-row click and "Full record" all swap strip **and** panel; 6 gallery links |
| `sweep.mjs` | `0 failing viewport/page combinations out of 63` |
| `palette.mjs` | `All non-failure chrome sits in the blue family.` |
| `clipboard.mjs` | clipboard matches `data-copy`; `0 copy buttons rendered with no script` |
| `copy-fallback.mjs` | tick shown via fallback; glyph drawn 16×16 |
| `cmd-box.mjs` | `0 failure(s)` |

---

#### 16.2.5 The four mechanisms

Understand these before changing anything interactive. They are what make the JS-off
requirement work.

##### 16.2.5.1 Layout is solved at build time

A tidy tree's row layout depends on how many leaves sit above each node. `lib/layout.mjs`
computes that in Node, so each page ships complete static SVG. The browser never computes
geometry. **If you add a node or change the tree shape, rebuild — do not try to fix layout
in CSS or JS.**

##### 16.2.5.2 State lives in CSS

The Tree|Stats switch and the four info chips are **native radio groups**
(`<input>` + `<label>`), shown and hidden with `body:has(#id:checked)`. No JS, and the
arrow keys work natively. Do not convert these to buttons or add JS to them.

##### 16.2.5.3 Selection has two paths and one outcome

Which version is on show can be decided two ways, and they must never fight:

- **No script** — the figure links to `#s-<short>`, and the generated `<slug>.css` uses
  `:target`.
- **With script** — `showcase-enhance.js` adds `is-open` to a `.selected-strip`, because `:target` is
  **not** re-evaluated when the fragment is rewritten in place (see Trap 1).

The generated rules cover both, and the `:target` half disables itself the moment a strip is
marked:

```css
:is(body:not(:has(.selected-strip.is-open)):has(#s-he-07:target),
    body:has(.selected-strip.is-open):has(.selected-strip[data-for="he-07"].is-open))
```

The mechanism is **custom properties**, not declarations — one rule covers the wide figure
and the narrow list, another covers the strip and its record. `theme.css` supplies the
defaults (`--sel-ring` falls back to `none`), so an unchosen version costs nothing.

##### 16.2.5.4 The progressive-enhancement gate

Controls that genuinely need a script carry `.needs-js` and are **hidden until the script
runs**:

```css
.needs-js { display: none; }                    /* not display:none in the markup */
html.has-js .icon-btn.needs-js { display: inline-flex; }
```

`showcase-enhance.js` adds `html.has-js` before it does anything else. So if the script never loads, the copy
buttons and the direction picker are simply absent — never shown-but-inert. The commands
themselves stay readable as plain text. **Never add a control that looks interactive but
needs JS without this gate.**

---

#### 16.2.6 Deliberate divergences from the reference

These are **intentional**. Do not "fix" them back to the reference without being asked.

| Area | Ours | Reference |
|---|---|---|
| Colour | M3 dark seeded from **blue** | M3 baseline purple (`#6750A4`) |
| `tertiary` | cyan (`#a2d2df`) | M3 pink |
| `.record-info` | `position: sticky` | static (leaves a tall void) |
| `.chips` | bare M3 filter-chip group, 32px, gap 8 | nested in a sunk panel, 34px, gap 4 |
| Radii | 8px / 12px (`--shape-sm` etc.) | fixed 10px |
| Copy control | 32px **icon button** with a clipboard glyph, **inside** the command box in both blocks | text button reading "Copy"; inside in `.checkit-cmd`, but **below** the command in `.np-block.fork` |
| `build.mjs` output | flat folder (`index.html`, `<slug>.html`) | Next.js routes |

The **copy control placement** is worth calling out because the reference is itself
inconsistent — see the table above. We put it inside in both places. The one consequence:
the button takes ~34px of the command's width (300 → 266px), which is what pushes the fork
command into wrapping at sidebar widths.

---

#### 16.2.7 Traps

Each entry: symptom → cause → the fix that works.

##### 16.2.7.1 `:target` is not re-evaluated by `history.replaceState()`

**Symptom.** Clicking a tree node changes the URL but nothing on screen moves.
**Cause.** The code drove selection off `:target` and only called `replaceState`.
Rewriting the fragment in place does not re-resolve `:target`.
**Fix.** `showcase-enhance.js` drives selection with the `is-open` class; the fragment is kept only so
the URL stays shareable. This is what §16.2.5.3 exists for.
**Trap.** A one-off test *appears* to prove `replaceState` works if it sets the fragment
during initial script execution — before the first style resolution, the target is simply
computed for the first time. Test the click, not the load.

##### 16.2.7.2 One fragment cannot mean two things

**Symptom (JS off).** Clicking "Full record ↓" silently resets the page to its default
version.
**Cause.** The strip carried `id="s-<short>"` and the figure linked to it, but "Full record"
pointed at `#record`, which matches none of the generated `#s-*:target` rules — so every
strip collapsed.
**Fix.** The `s-<short>` id lives on the **record `<article class="rec">`**, so one fragment
both selects the version and scrolls to it. `showcase-enhance.js` keys selection off
`strip.dataset.for`, not `strip.id`, and the "Full record" link is a plain anchor with no
`preventDefault`. `.rec` carries `scroll-margin-block-start: 64px` to clear the top bar.
The "nothing chosen yet" test is therefore `body:not(:has(.rec:target))` — **not**
`.selected-strip:target`.

##### 16.2.7.3 `data-fork-out` must stay on the `<pre>`

**Symptom.** The fork block's copy button disappears the first time the direction picker
changes.
**Cause.** `showcase-enhance.js` does `out.textContent = …`, which **replaces every child**. If the
attribute sits on the wrapper, the button is a child and gets deleted.
**Fix.** Keep `data-fork-out` on the `<pre>` and the button a *sibling* of it.
`checks/cmd-box.mjs` asserts both.

##### 16.2.7.4 The copy button is a sibling, not a child

Same root cause as 16.2.7.3, generalised: **never nest a copy button inside the element whose
text is copied.** `data-copy` (literal string) and `data-copy-out` (read from a
`[data-fork-out]` element) are the two hooks.

##### 16.2.7.5 Chromium reports `fill` as `rgb(0, 0, 0)` for HTML elements

**Symptom.** A colour probe reports black for every link.
**Cause.** For an **HTML** element, `fill` is a meaningless `rgb(0, 0, 0)` — it is *not*
`none`. A probe that "falls back to `color` when `fill` is none" silently reports black.
**Fix.** Name the CSS channel to read per element in `checks/palette.mjs` (`PROBES`).

##### 16.2.7.6 Playwright forces light mode

Every page here is dark-only. Pass `colorScheme: "dark"` to the context, or screenshots and
measurements will not match.

##### 16.2.7.7 `waitUntil: "load"` never settles on `file://` with scripting off

Use `{ waitUntil: "domcontentloaded" }` in a `javaScriptEnabled: false` context.

##### 16.2.7.8 Chromium normalises clipboard newlines to CRLF

Comparing clipboard content against a `<pre>`'s text fails on `\n` vs `\r\n`. Normalise
before comparing.

##### 16.2.7.9 Unscoped selectors match hidden records

**Symptom.** A geometry assertion passes when it should fail, or a readability check
reports `false`.
**Cause.** Every record ships its own fork block, check-it list and panels, but only one is
displayed. `document.querySelector(".fork .cmd")` returns the **first**, which belongs to a
hidden record and measures **0×0** — and a 0×0 box satisfies every containment test for
free.
**Fix.** Scope to the visible record: `.rec[data-for="he-08"]`. `checks/cmd-box.mjs`
additionally asserts the box has non-zero size, so a vacuous pass is impossible.

##### 16.2.7.10 Edge reports `file://` as a secure context

**Symptom.** The `execCommand` fallback path is never exercised locally.
**Cause.** `navigator.clipboard` is present even on `file://` in Edge, so the fallback never
runs.
**Fix.** `checks/copy-fallback.mjs` deletes `navigator.clipboard` before load to force the
fallback. The fallback is not dead code — it is the only route in a genuinely insecure
context.

##### 16.2.7.11 The figure's SVG text is in user units

`.h-word`, `.h-num` and the objective labels are inside the SVG viewBox, and the build
computes label boxes from character counts. **Resizing them desyncs the geometry.** The
"no text below 12px" rule applies to HTML labels only.

##### 16.2.7.12 A `--flag` can break after its hyphen

**Symptom.** A command renders as `--` at the end of one line and `area` at the start of the
next.
**Cause.** A hyphen is a legitimate CSS break opportunity.
**Fix.** There isn't one in CSS. `word-break: keep-all`, `line-break: strict`,
`break-spaces` and `overflow-wrap: anywhere` were all measured and break in the same place.
Only markup around each token would stop it. `checks/cmd-box.mjs` reports it as a `note`,
not a failure. A soft wrap inserts **no characters**, so the clipboard payload is unaffected.

##### 16.2.7.13 `overflow-wrap: break-word` splits words mid-token

It breaks a token at the overflow point — `improves` becomes `improv` / `es`. Use
`overflow-wrap: normal`, which only breaks at real opportunities.

**Trap within the trap:** at the real content widths, `break-word` and `normal` render
*identically*, so a test asserting "no mid-word break" passes under both and proves nothing.
The assertion only becomes meaningful with a synthetic over-long token. If a test can never
go red, it is not evidence.

##### 16.2.7.14 `@layer` order is load-bearing

`@layer tokens, base, layout, card, glyph, page, motion;` — this is why the stylesheet needs
no `!important`. Put new rules in the correct layer. `.checkit-cmd` sits in `page`, after
`.cmd`, and relies on source order for its one extra declaration.

##### 16.2.7.15 Tap targets need real padding

A `::after` pseudo-element "hit area" was tried and **reverted**: `elementsFromPoint` showed
it does not extend the hit area, and tooling cannot measure it. Use real `padding-block`.

##### 16.2.7.16 Do not hand-edit generated CSS or HTML

`<slug>.css` carries a GENERATED header. Edit `selectionCss()` in `build.mjs` and rebuild.

---

#### 16.2.8 Conventions

- **Comments explain *why*, not what.** A rule that looks odd usually has a reason recorded
  next to it — read it before changing the rule. Several comments name the alternative that
  was measured and rejected.
- **Escape every interpolation** in `build.mjs` with `esc()`.
- **No raw colour outside `@layer tokens`.** Use M3 role names (`--md-sys-color-*`),
  `--md-state-*` for state layers, `--shape-*` for radii, `--type-*` for type. If a value is
  not an M3 role, say so in a comment.
- **Additive JS only.** If `showcase-enhance.js` never loads, the pages still work. Anything that cannot
  meet that bar goes behind the `.needs-js` gate.
- **Prefer one shared rule over two near-identical ones.** The two command blocks share
  `.cmd`; the two strip/record reveals share the generated `--sel-*` properties.
- **Delete dead CSS.** There is no unused-class linter in `checks/`, so grep the stylesheet
  against the generated markup before assuming a class is still needed. (An earlier
  `check.mjs` did this and is no longer present — worth reinstating if dead CSS becomes a
  recurring problem.)

---

#### 16.2.9 Do not

- Add a dependency, framework, bundler or CDN script.
- Add a build step other than `node build.mjs`.
- Move a page out of `dist/`. The preview harness maps each directory to its own base
  path, so `index.html` and `tree/*.html` would get different bases and every card link
  would 404. Every generated page lives in the one flat `dist/` folder for this reason.
- Hand-edit anything under `dist/`.
- Edit anything in `ref/`.
- Convert the radio-group switch or chips to JS.
- Put an interactive-looking control in the markup without the `.needs-js` gate.
- Trust a green test without checking it can go red (see 16.2.7.13).
- Claim a layout change is done without running `sweep.mjs` — 63 viewport/page
  combinations is the only thing that catches a narrow-width regression.

---

#### 16.2.10 If you are asked to match the reference more closely

1. Measure, do not eyeball. Render the live site with Playwright at the same viewport
   (`colorScheme: "dark"`) and compare **computed box models**.
2. Compare the DOM, not just the pixels. A previous "the switch must be fragment-driven"
   assumption was wrong — reading `ref/components/Panels.tsx` showed React buttons with
   `aria-pressed` and no anchors at all, and the change was reverted.
3. Check §16.2.6 first — the difference may be deliberate.
4. After any change, run the full suite in §16.2.4.3.
