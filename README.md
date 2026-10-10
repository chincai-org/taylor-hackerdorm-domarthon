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
Workbuddy ("Improve this node") --MCP--> FastAPI server --runs--> DeepSeek / PI
                                              |
                         +--------------------+----------------+
                         |                    |                |
                    REST (/api/v1)      MCP (/mcp)      Pages (/ , /tree/*)
                         |                                 |
                    Live gallery +                   Tree lineage, node
                    tree detail                      detail, scores
```

1. Seed a tree with a benchmark and a root node.
2. Workbuddy calls `get_node` to read the exact parent harness and receives a
   derived `parent_revision` hash.
3. Workbuddy passes that revision to `create_child_node` with bounded,
   parent-relative `suggested_changes` + rationale, never a full harness file.
4. The server materializes the child by preserving every unmentioned parent
   field. Suggestions are capped at 120 lines; evaluation remains pending/skipped
   until the benchmark runner is connected.

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

Without `DEEPSEEK_API_KEY`, the server still runs; DeepSeek-backed routes
return 503.

## Demo loop (2 minutes)

1. Open `/` and pick a tree.
2. Click nodes in the lineage to inspect harness, score, and per-scenario
   benchmark results (passed / failed / unscored, never raw JSON dumps).
3. As Workbuddy, with a `tree_id` + `node_id`: `get_node` (read the exact
   parent harness and capture `parent_revision`) → inspect the tree digest and
   benchmark context → submit the revision plus parent-relative
   `suggested_changes` with `create_child_node` → reload the tree page.

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
  services/          # DeepSeek client, tree digest helpers
  mcp_server.py      # MCP tools: list/get/create nodes, benchmark, status
  web/
    templates/       # Live pages: base.html, gallery.html, tree-detail.html
    static/          # Served at /trees: theme.css, live-viewer.css/js
scripts/             # One-off helpers (DeepSeek eval)
benchmarks/          # Customer-support scenario sets (immutable once used)
tests/               # pytest suite (sqlite-backed, no network)
```

Benchmarks are programmatic checks (expected tool calls, expected final action,
forbidden actions) — deterministic, no LLM-as-judge by default.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres URL (`.env.development.local` locally) |
| `DEEPSEEK_API_KEY` | Model API key for evaluation |
| `DEEPSEEK_MODEL` | Model name (default `deepseek-chat`) |
| `DEEPSEEK_BASE_URL` | Endpoint override |
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
