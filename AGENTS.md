# AGENTS.md

Guide for AI coding agents (+ humans). **24h hackathon**: end-to-end > polish, small changes, no over-engineering.

## 1. Project Overview

**One AI optimizes harness of another AI.**

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
| **Judge model**    | Model the server scores harnesses with (GraffiLab AI API, OpenAI-compatible). |

## 3. Architecture

```
┌────────────────────┐        MCP         ┌──────────────────────────────┐
│ Workbuddy (user)   │ ─────────────────► │ Hosted server (FastAPI)      │
│ "Improve this node"│ ◄───────────────── │  - MCP server (python mcp)   │
└────────────────────┘                    │  - REST API for frontend     │
                                          │  - Evaluator (judges dsh     │
┌────────────────────┐      REST/JSON     │    benchmark)                │
│ Web frontend       │ ─────────────────► │  - DB (trees, nodes, results)│
│ (Vercel)           │ ◄───────────────── └──────────────┬───────────────┘
└────────────────────┘                                   │
                                                         ▼
                                              GraffiLab AI API (judge)
```

- **Server**: stores tree, judges dsh harnesses vs benchmark, stores results, exposes MCP + REST.
- **Workbuddy**: user-side. No direct DB access — MCP only.
- **Frontend**: lists sessions, tree viz, node/benchmark detail. Optional "create session".

## 4. Tech Stack

- **Backend:** Python, FastAPI, official MCP Python SDK (`mcp`) mounted alongside FastAPI.
- **Database:** SQLAlchemy models + repository helpers, Neon Postgres local + Vercel. Harnesses/scenarios/results in JSON fields; DB access behind `app/db/repository.py`.
- **Frontend:** Vercel. Tree viz (React Flow / d3 / plain SVG). Prefer already-scaffolded.
- **Eval runtime:** judge model via GraffiLab AI API.

> Repo choice beats this file on conflict — then update this section.

## 5. Repository Layout

Don't restructure without reason.

```
/
├── AGENTS.md
├── app/
│   ├── main.py              # FastAPI app; mounts /trees + REST/MCP routers
│   ├── api/                 # REST endpoints for frontend
│   ├── core/                # Settings
│   ├── db/                  # Engine, models, repository (SQLAlchemy + Neon Postgres)
│   ├── harness/             # Harness import helpers
│   ├── schemas/             # Shared Pydantic models (MCP + REST)
│   ├── services/            # Model clients, digest helpers, tool runtime (agent loop)
│   ├── mcp_server.py        # MCP tool definitions
│   └── web/                 # Everything browser sees
│       ├── templates/       # Live pages: base.html, gallery.html (/),
│       │                    # tree-detail.html (/tree/*)
│       └── static/          # Served at /trees: theme.css, live-viewer.css/js
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

Scoring (implemented in `app/services/evaluator.py`, one-shot rollout-then-judge, rubric v3 low-skew):
- One-shot batch per node: the tree's dataset is loaded from the database
  (`benchmarks.scenarios` via `load_benchmark_scenarios` /
  `evaluate_tree_harness_sync`), all scenario questions are combined into ONE
  prompt (`_batch_candidate_prompt`) and POSTed once with the harness text via
  `POST {CANDIDATE_BASE_URL}/api/v1/deepseek/chat`
  (`{prompt, harness_yml, max_steps, model}` pinned to the judge model), then a
  single GraffiLab judge call (temperature 0) carries the harness + ALL
  expectations + the full combined output, returning per-scenario verdicts
  `{"scenarios": [{"scenario_id", "passed", "score", "reason"}...]}`.
- Fixed rubric (single source of truth: `_rubric_text()`; system prompt and every
  judge prompt embed the same text): bands 99-100 flawless (essentially perfect
  only) / 92-98 satisfies (narrow pass band) / 50-91 partial / 0-49 fail, deliberately
  skewed low — most real outputs should land well below 50; independent caps applied
  as minimum — forbidden action 10, wrong final action 30, missing expected tool 40,
  invented policy/guaranteed outcome 15, missing escalation (billing/safety/unresolved) 40.
  Binary pass/fail plus 0-100 score, harsh per-scenario verdicts
  (fence-tolerant parse; unparseable verdicts fail those scenarios at 0 and never
  pass; missing fields derive conservatively, pass = score 92+ with `passed: true`).
- Judge model = `JUDGE_MODEL` override, else the provider model; judge temperature =
  `JUDGE_TEMPERATURE` (0). Rollout uses the candidate API's default sampling (no
  temperature pin available) — scores are comparable, not bit-identical.
- Score = mean of the per-scenario 0-100 scores (float, rounded to 2dp).
- Rollout error fails every scenario (`candidate_error`, judge not called, saves
  quota); judge transport error (`judge_error`), unparseable verdict
  (`judge_parse_error`), and total-budget exhaustion (`eval_total_timeout`) all
  fail unfinished scenarios at 0. Results record `"batched": true` plus the shared
  batch prompt/reply so scores stay comparable across runs.
- Scenarios are **optional**: an empty benchmark falls back to one generic
  harness review (persona, escalation, no guaranteed outcomes), marked
  `"generic": true` on the result so Workbuddy knows it is not scenario-backed.
- Report: overall score, per-scenario pass/fail, failure reasons. Per-scenario detail = what Workbuddy learns from.
- **Immutable once tree has nodes** — changes invalidate comparisons.

## 8. MCP Interface

Workbuddy flow: user gives `tree_id` + `node_id`, prompts **"Improve this node"**. Call order ≈ table order.

| Tool                                                                  | Purpose                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list_trees()`                                                        | Sessions (id, name, best score, node count).                                                   |
| `get_tree(tree_id)`                                                   | Tree summary + structure (node ids, parents, scores).                                          |
| `get_node(tree_id, node_id)`                                          | Harness, benchmark results (incl. per-scenario failures), rationale.                           |
| `get_children(tree_id, node_id)`                                      | Prior attempts: harness diffs/results/rationale.                                               |
| `get_benchmark(tree_id)`                                              | Benchmark description → what gets measured.                                                    |
| `create_child_node(tree_id, parent_id, suggested_changes, rationale)` | Create child from bounded parent-relative changes; preserve unmentioned parent harness fields. |
| `get_node_status(tree_id, node_id)`                                   | Poll eval status/result.                                                                       |
| Tool                                                        | Purpose                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `list_trees()`                                              | Sessions (id, name, best score, node count).                              |
| `checkout_tree(tree_id)`                                    | Tree digest: benchmark, structure, harnesses, scores, failure summaries.  |
| `get_node(tree_id, node_id)`                                | Harness, benchmark results (incl. per-scenario failures), rationale.      |
| `create_child_node(tree_id, parent_id, parent_revision, suggested_changes, rationale)` | Create child from bounded parent-relative changes; block while the judge scores it. |

Rules:
- **Concise structured JSON**. Truncate big payloads; offer drill-down.
- `checkout_tree` / `get_node` must carry enough context → **avoid repeating failed approaches**.
- `get_node` is the required parent-read step before creating a child; pass its `parent_revision` unchanged to `create_child_node`.
- `create_child_node` verifies the derived parent revision against the current database harness; no schema field is required.
- `suggested_changes` is parent-relative, not a full harness file; unmentioned fields are preserved and the server caps the payload at 120 lines.
- `create_child_node` validates parent exists and belongs to the tree. Eval is
  synchronous (blocks with batch + total timeouts); no poll tool.
- Child scoring below parent = regression → `failed` (`regression` error, score +
  result kept for learning). Branch from parent/better nodes, never failed ones.
- No stuck `running`; mark `failed` on error/timeout.
- Errors clear + actionable (what wrong, what next).

## 9. Evaluation Flow (server-side)

1. `create_child_node` inserts node `status=pending` (root nodes: `POST /api/v1/trees`).
2. Evaluator sets `running`, rolls out the harness in one shot via the candidate
   API (all scenario questions in ONE prompt), then judges once via GraffiLab
   (one verdict per scenario; generic review when scenarios are empty).
3. Writes `score` + `result`, sets `complete` (or `failed` + error).
4. Frontend + MCP read updated node.

- Batch + total timeouts (`JUDGE_TIMEOUT_S`, `EVAL_CANDIDATE_TIMEOUT_S`,
  `EVAL_TOTAL_TIMEOUT_S`) → protects API quota (hackathon budget!). Total-budget
  exhaustion fails only unfinished scenarios; finished verdicts are kept.
- Deterministic where possible (judge temperature 0, fixed rubric v3 recorded on
  every result; rollout inherits candidate default sampling).

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
```

### DeepSeek agent API (autonomous tool loop, streamed over SSE)

- `POST /api/v1/deepseek/chat` → one JSON reply (`reply`, `tool_calls`, `steps`, harness echo).
- `POST /api/v1/deepseek/stream` → same result as SSE (`curl -N` / no-buffer keeps live).
- Both take `{ prompt, harness_yml?, harness?, system_prompt?, tools?, model?,
  timeout?, max_steps?, auto_tools? }`.
  Harness is raw `cordis.patch.yml` text in `harness` or `harness_yml`. Mutually
  exclusive; omit both → bare prompt-only.
- `max_steps` (default 5, 1–10): agent-loop cap — model → execute tools →
  feed `role:tool` results back → repeat until text-only reply or cap.
  `1` = old single-shot. `auto_tools` (default true) derives executable tools
  from harness rows; explicit `tools` always merge on top (no dedup clobber).
- Harness rows *enable* tool families (schemas fixed server-side in
  `app/services/tool_runtime.py`): `dsh-plugin-fs` / `dsh-fs*` → `fs_list`,
  `fs_read` (sandboxed to `./workspace`, traversal blocked, caps); 
  `dsh-plugin-web-search` / `dsh-tool-web*` → `web_search`, `web_fetch`
  (stdlib `urllib`, short timeout, truncated text). Enabled families move from
  `ignored_plugins` to `applied_plugins` as `auto-tools:fs` / `auto-tools:web`
  + `policy_notes: "auto-tools=fs,web max_steps=N"`. Truly inert rows (e.g.
  `cordisjs:plugin-logger`) stay `ignored`. Executors never raise — failures
  become `{"error": ...}` so the loop can recover. `dsh-plugin-openai` allows
  only `{baseURL, apiKey, apiKeyEnv, model}`; extras (e.g. `forceToolCalling`)
  are dropped with a `warnings` entry. Harness `baseURL` is echo-only
  (`policy_notes`); the call uses server `DEEPSEEK_BASE_URL`.
- Chat reply: `tool_calls` = all calls across steps (executed server-side),
  `steps` = per-step `{tool_calls, tool_results}`, `executed_tools` = families
  (e.g. `["fs","web"]`).
- SSE order: first event always `{"harness": "..."}` (harness text + `model`,
  `applied_plugins`, `ignored_plugins`, `policy_notes`, `warnings`, `dropped`)
  → per step `{"step": N, "tool_calls": [...]}` + one `{"tool_result": {...}}`
  per call → aggregate `{"tool_calls": [...]}` → `{"delta": final reply}` →
  `{"status": "done"}` or `{"error"}`.
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
scenarios/harnesses. `max_steps` defaults to 5 (autonomous loop); add
`max_steps: 1` for single-shot or `auto_tools: false` to disable harness tools.

Observed SSE transcript (trimmed — `web_search` hit rate limits, `web_fetch`
of the pasted GitHub URL succeeded, model then answered from tool output):

```text
data: {"harness": "# Generated from Node.harness ...", "model": "grafilab/deepseek-v4-flash",
        "applied_plugins": ["dsh-plugin-openai", "auto-tools:fs", "auto-tools:web"],
        "ignored_plugins": ["cordisjs:plugin-logger"],
        "policy_notes": ["harness baseURL=https://llm.grafilab.ai/v1",
                         "auto-tools=fs,web max_steps=5"],
        "warnings": ["llm-adapter: dropped unsupported config key 'forceToolCalling'"], ...}
data: {"step": 1, "tool_calls": [{"name": "web_search", "arguments": {"query": "..."}}, ...]}
data: {"tool_result": {"name": "web_search", "result": {"answer": "", ...}}}
data: {"step": 2, "tool_calls": [{"name": "web_fetch", "arguments": {"url": "https://github.com/lhldev/cneuron"}}]}
data: {"tool_result": {"name": "web_fetch", "result": {"url": "...", "content": "GitHub - lhldev/cneuron: Lightweight MLP library in C. ..."}}}
data: {"tool_calls": [...all three...]}
data: {"delta": "I found the repository **lhldev/cneuron** ... Lightweight MLP library in C ..."}
data: {"status": "done"}
```

Local + Vercel both use Neon Postgres. Local pooled string in `.env.development.local`;
Vercel provides own `DATABASE_URL`. Same DB code both envs, only credentials differ.

Env vars (never commit secrets; provide `.env.example`):
- `GRAFFILAB_API_KEY` — judge model API (expected credential; `GRAFFILAB_BASE_URL` /
  `GRAFFILAB_MODEL` default to the deployed endpoint/model, `JUDGE_MODEL` overrides the judge)
- `DEEPSEEK_API_KEY` (+ `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`) — override path, wins when set
- `DATABASE_URL` — Neon Postgres URL; local via `.env.development.local`
- `NEXT_PUBLIC_API_URL` / equivalent — frontend → server base URL

## 12. Coding Conventions

- **Python:** type hints, Pydantic models for all req/resp bodies, small fns, `async` where helps (model calls, MCP).
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
- [ ] MCP tools read tree digest with benchmark context.
- [ ] `create_child_node` stores node + auto-runs the Grafilab judge vs benchmark.
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
- scenarios is an array of objects: `{question: string, answer: string}`.
- Status ∈ `pending`, `running`, `complete`, `failed`.
- `ix_nodes_tree_parent` (`tree_id`, `parent_id`) → traversal.
- `ix_nodes_tree_status` (`tree_id`, `status`) → status filter.
- `ix_nodes_tree_score` (`tree_id`, `score`) → ranking.


- Exact GraffiLab AI API shape, auth, rate limits.
- Eval sync vs async-with-polling for MCP.
- "Create session" in MVP?
- MCP transport (streamable HTTP vs SSE) for hosted deploy — Vercel serverless limits may push long evals elsewhere (small VM/Fly/Railway), Vercel serving frontend only.

---

## 16. Frontend guidance — live backend viewer

- Live gallery `/` renders `app/web/templates/gallery.html`. Native cards → `/tree/{tree_id}`
  from `app/web/templates/tree-detail.html`. Both extend `base.html` (shared head/topbar/
  favicon/live assets). Detail fetches only `/api/v1/trees/{tree_id}` + native Back to trees
  link. FastAPI serves live assets at `/trees` (`html=True`); `/favicon.ico` from `public/`
  via explicit route. REST contracts unchanged.
- Harness block pairs Try-harness beside Copy: Try POSTs that node's harness to
  `/api/v1/dsh/launch` and opens the literal dsh web UI straight away.
- `POST /api/v1/dsh/launch` boots the literal dsh web UI on a node's harness
  (exports yml to temp workspace, returns local URL). Launch also passes a
  `--patch` overlay registering Grafilab (`openai-completions`,
  `grafilab/deepseek-v4-flash`) as default provider — without it dsh sends
  catalog id `deepseek-flash`, which Grafilab 404s as "invalid key".
  `ALLOW_DSH_SPAWN` in settings (`.env.development.local`, never hosted).
- Keep loading/failure/retry handling on both live pages. Node selection keeps keyboard
  focus on selected link; live region announces changes.
- `app/web/static/live-viewer.js` drives both pages (fetch, lineage SVG, node panel, copy
  controls). Sets `has-js` itself + clipboard `execCommand` fallback + below-fold card
  reveal (IO-guarded, reduced-motion respected). Lineage labels cut at word boundary +
  `…`, full text in SVG `<title>` tooltip + `aria-label`; selected node auto-scrolls
  inside plate (plate only, never page). No Node build needed in Python container.
- Live nodes: `pending`, `running`, `complete`, `failed`; nullable raw scores, harness text,
  rationale, results, errors. Harness payload has copy control (payload verbatim).
  Scenario-array results → passed/failed/unscored cards; summary-only → labeled facts. No raw
  result JSON in normal detail UI. Wide lineage SVG centered in bounded scroll stage.
- Live data needs JS. No-JS shell links JSON API/docs instead of fictional data.
- `theme.css` = shared M3 theme (tokens → motion layers, no `!important`); `live-viewer.css`
  scopes live styles to `.live-trees`. No raw colour outside `@layer tokens`.
- Gallery create form (`#tree-create-form`) POSTs JSON to `/api/v1/trees`, shows inline
  status, resets + refreshes cards on 201. Button sits in fields row; status is own
  full-width row below (`:empty` hidden).
- Detail auto-refreshes pending/running selection every 3s (re-render only on
  status/score/result change; pauses when tab hidden; no overlapping fetches).
- Verify via `uv run pytest` + live HTTP smoke (`/`, `/tree/x`, `/favicon.ico`, assets).
