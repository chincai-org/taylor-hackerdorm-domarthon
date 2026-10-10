# Harness Trees — one AI optimizes the harness of another AI

A 24-hour hackathon build. A **harness** is everything wrapped around a
customer-support agent: system prompt, tool definitions, routing and policy
instructions. Harnesses live in a **tree**: each node is one harness version
plus its benchmark score. An optimizer agent ("Workbuddy") reads a node over
MCP, proposes a better harness, and submits it back as a child node. The
server evaluates every child automatically. Failures stay in the tree — they
are signal, not noise.

Scope: customer support only.

## How it works

```
Workbuddy ("Improve this node") --MCP--> FastAPI server --runs--> GraffiLab judge
                                              |
                         +--------------------+----------------+
                         |                    |                |
                    REST (/api/v1)      MCP (/mcp)      Pages (/ , /tree/*)
                         |                                 |
                    Live gallery +                   Tree lineage, node
                    tree detail                      detail, scores
```

1. Seed a tree with a benchmark and a scored root node (judged at creation).
2. Workbuddy calls `checkout_tree` to study a node and its past attempts
   (including failures), then `get_node` to read the exact parent harness and
   receive a derived `parent_revision` hash.
3. Workbuddy passes that revision to `create_child_node` with bounded,
   parent-relative `suggested_changes` + rationale, never a full harness file.
4. The evaluator judges the materialized child against every benchmark scenario via
   direct Grafilab LLM calls (temperature 0, JSON verdict per scenario) and
   stores the mean 0-100 score. Trees with no scenarios yet get one generic
   harness review instead, marked `"generic": true`. The tree page shows the
   new node immediately.

## Quickstart

```bash
uv sync

# Point at Postgres (Neon locally and in production; only credentials differ).
# Copy .env.example to .env.development.local and fill in DATABASE_URL.
uv run python -c "from app.db import create_tables; create_tables()"

uv run uvicorn app.main:app --reload --port 5001
```

Then open:

- `http://127.0.0.1:5001/` — live gallery of optimization trees
- `http://127.0.0.1:5001/tree/<tree_id>` — tree lineage, node detail, scores
- `http://127.0.0.1:5001/docs` — REST API docs
- `/mcp` — MCP endpoint Workbuddy talks to

Without a model API key, the server still runs; model-backed routes
(`POST /api/v1/deepseek/chat|stream`) return 503 and new nodes land `failed`
with a clear error. The expected credential is `GRAFFILAB_API_KEY`
(GraffiLab model endpoint); `DEEPSEEK_API_KEY` wins when both are set.
`GET /api/v1/deepseek/health` reports the active provider.

## Demo loop (2 minutes)

1. Open `/` and pick a tree.
2. Click nodes in the lineage to inspect harness, score, and per-scenario
   benchmark results (passed / failed / unscored, never raw JSON dumps).
3. As Workbuddy, with a `tree_id` + `node_id`: `checkout_tree`
   (read why past attempts failed) → `get_node` (read the exact
   parent harness and capture `parent_revision`) → `create_child_node`
   with parent-relative `suggested_changes` (blocks until the
   judge scores it) → reload the tree page to see the new node.

One-off harness comparison without the server:

```bash
export DEEPSEEK_API_KEY="<key>"
uv run python scripts/deepseek_eval.py
```

## DeepSeek agent API (prompt + harness over SSE)

`POST /api/v1/deepseek/chat` returns one JSON reply.
`POST /api/v1/deepseek/stream` streams the same result as SSE.
Both take `{ prompt, harness_yml?, system_prompt?, tools?, model?, timeout? }`
— pass `cordis.patch.yml` text as `harness_yml`. First SSE event is always the
normalized `{"harness": {...}}`, then `{"delta"}` chunks, then
`{"status": "done"}` or `{"error"}`.

```bash
jq -n --arg prompt "I was charged twice for the same order." \
  --rawfile yml cordis.patch.yml \
  '{prompt: $prompt, harness_yml: $yml}' > /tmp/body.json

curl -N -X POST http://127.0.0.1:5001/api/v1/deepseek/stream \
  -H 'Content-Type: application/json' \
  -d @/tmp/body.json
```

## Project layout

```
app/
  main.py            # FastAPI: mounts /, /tree/*, /trees, /api/v1, /mcp
  api/               # REST for the frontend (trees, harness, deepseek)
  core/              # Settings / env
  db/                # SQLAlchemy models + repository (Neon Postgres)
  harness/           # Harness import helpers (incl. Cordis/DSH)
  schemas/           # Shared Pydantic models (REST + MCP stay in sync)
  services/          # Model client, LLM-judge evaluator, tree digest helpers
  mcp_server.py      # MCP tools: list/get/create nodes, benchmark, status
  web/
    templates/       # Live pages: base.html, gallery.html, tree-detail.html
    static/          # Served at /trees: theme.css, live-viewer.css/js
scripts/             # One-off helpers (DeepSeek eval)
benchmarks/          # Customer-support scenario sets (immutable once used)
tests/               # pytest suite (sqlite-backed, no network)
```

Benchmarks are scenario sets (customer message, expected intent/tools/
final action, forbidden actions). Scoring is LLM-as-judge via direct
GraffiLab API calls — fixed rubric, binary pass/fail plus a 0-100 score,
temperature 0, one JSON verdict per scenario, node score = mean. Scenarios are optional: an empty
benchmark falls back to one generic harness review (marked `"generic": true`).

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres URL (`.env.development.local` locally) |
| `GRAFFILAB_API_KEY` | Model API key for evaluation (GraffiLab model endpoint) |
| `GRAFFILAB_BASE_URL` | Endpoint override (default `https://llm.grafilab.ai/v1`) |
| `GRAFFILAB_MODEL` | Judge/candidate model (default `grafilab/deepseek-v4-flash`) |
| `JUDGE_MODEL` | Judge model override (defaults to the provider model) |
| `DEEPSEEK_API_KEY` | Override credential (wins when set; DeepSeek endpoint/model apply) |
| `DEEPSEEK_MODEL` | Model name when using the DeepSeek override (default `deepseek-chat`) |
| `DEEPSEEK_BASE_URL` | Endpoint override for the DeepSeek path |
| `NEXT_PUBLIC_API_URL` | Frontend → API base URL if split |

Never commit secrets. See `.env.example`.

## Tests and checks

```bash
uv run pytest                                     # backend (sqlite, no network)
uv run ruff format . && uv run ruff check .       # lint
```

## For agents

`AGENTS.md` is the full contributor guide: data model, MCP interface,
DeepSeek SSE API, evaluation flow, database schema, and frontend rules.
