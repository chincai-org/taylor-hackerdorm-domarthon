# Sharpmon — an AI monster that sharpens the harness of another AI

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
Workbuddy ("Improve this node") --MCP--> FastAPI server --judges--> GraffiLab council
                                              |
                         +--------------------+----------------+
                         |                    |                |
                    REST (/api/v1)      MCP (/mcp)      Pages (/ , /tree/*)
                         |                                 |
                    Live gallery +                   Tree lineage, node
                    tree detail                      detail, scores
```

1. Create a tree (gallery form or MCP): it seeds a benchmark and a scored root
   node, judged at creation.
2. Workbuddy calls `checkout_tree` to study a node and its past attempts
   (including failures), then `get_node` to read the exact parent harness and
   receive a derived `parent_revision` hash.
3. Workbuddy passes that revision to `create_child_node` with bounded,
   parent-relative `suggested_changes` + rationale — never a full harness file.
4. The evaluator scores the child against every benchmark scenario and stores
   the result. **A child scoring below its parent is marked `failed`** as a
   regression (score kept for learning) — branching continues only from
   equal-or-better nodes. The tree page shows the new node immediately.

## Evaluation: one rollout, five judges

Each node evaluation runs all scenario questions in **one** candidate prompt,
then fans out to a **council of 5 independent judge models** (temperature 0,
same prompt, no shared context):

- `qwen/qwen3.8-flash` · `z-ai/glm-5.3` · `deepseek/deepseek-v4-pro` ·
  `tencent/hy3` · `grafilab/gemma-4-31b-it`

Per scenario the ballots collapse to the **median** score (outlier-proof),
verdict follows median vs 92. A ballot strictly farthest from the median and
≥ 25 points away is quarantined to `dissent` — stored, never shown to the
actor. Wide spreads are flagged `contested`. Node score = mean of scenario
medians. The tree detail page renders contested badges and minority views
for humans; Workbuddy sees the full ballots via MCP.

Rubric v3 is deliberately low-skew: bands 99–100 flawless / 92–98 satisfies /
50–91 partial / 0–49 fail, with independent caps (forbidden action 10, wrong
final action 30, missing tool 40, invented policy 15, missing escalation 40).
Most real outputs land well below 50 — headroom is the point. An empty
benchmark falls back to one generic harness review, marked `"generic": true`.

## Quickstart

```bash
uv sync

# Point at Postgres (Neon locally and in production; only credentials differ).
# Copy .env.example to .env.development.local and fill in DATABASE_URL.
uv run python -c "from app.db import create_tables; create_tables()"

uv run uvicorn app.main:app --reload --port 5001
```

Then open:

- `http://127.0.0.1:5001/` — live gallery (create form + optimization trees)
- `http://127.0.0.1:5001/tree/<tree_id>` — tree lineage, node detail, scores,
  per-scenario council verdicts, auto-refresh while nodes evaluate
- `http://127.0.0.1:5001/docs` — REST API docs
- `/mcp` — MCP endpoint Workbuddy talks to

Without a model API key, the server still runs; model-backed routes
(`POST /api/v1/deepseek/chat|stream`) return 503 and new nodes land `failed`
with a clear error. The expected credential is `GRAFFILAB_API_KEY`;
`DEEPSEEK_API_KEY` wins when both are set.
`GET /api/v1/deepseek/health` reports the active provider.

## Demo loop (2 minutes)

1. Open `/`, create a tree, pick it.
2. Click nodes in the lineage to inspect harness, score, per-scenario
   verdicts with council dissent where judges disagreed.
3. As Workbuddy: `checkout_tree` → `get_node` (capture `parent_revision`) →
   `create_child_node` with `suggested_changes` (blocks until the council
   scores it) → beat the parent or land `failed` as a regression.
4. Hit **Try harness** beside any node's Copy button to boot the literal
   DeepSeek web UI on that harness (local server only, needs
   `ALLOW_DSH_SPAWN=1`).

One-off harness comparison without the server:

```bash
export DEEPSEEK_API_KEY="<key>"
uv run python scripts/deepseek_eval.py
```

## DeepSeek agent API (prompt + harness over SSE)

`POST /api/v1/deepseek/chat` returns one JSON reply (`reply`, `tool_calls`,
`steps`, harness echo). `POST /api/v1/deepseek/stream` streams the same
result as SSE. Both take `{ prompt, harness_yml?, harness?, system_prompt?,
tools?, model?, timeout?, max_steps?, auto_tools? }` — harness is raw
`cordis.patch.yml` text (mutually exclusive forms; omit both for prompt-only).
`max_steps` (default 5) caps the autonomous tool loop; first SSE event is
always the normalized `{"harness": ...}`, then per-step events, `{"delta"}`,
and `{"status": "done"}` or `{"error"}`.

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
  main.py            # FastAPI: mounts /, /tree/*, /trees, /api/v1, /mcp, /favicon.ico
  api/               # REST for the frontend (trees, harness, deepseek, dsh)
  core/              # Settings / env
  db/                # SQLAlchemy models + repository (Neon Postgres)
  harness/           # Harness import helpers (incl. Cordis/DSH)
  schemas/           # Shared Pydantic models (REST + MCP stay in sync)
  services/          # Model client, council evaluator, tree creation + digest
  mcp_server.py      # MCP tools: list/get/create nodes, benchmark, status
  web/
    templates/       # Live pages: base.html, gallery.html, tree-detail.html
    static/          # Served at /trees: theme.css, live-viewer.css/js
scripts/             # One-off helpers (DeepSeek eval)
benchmarks/          # Customer-support scenario sets (immutable once used)
tests/               # pytest suite (sqlite-backed, no network)
```

Benchmarks are scenario sets (`{question, answer}` per scenario, managed per
tree). Scoring is council-of-5 via GraffiLab — fixed rubric v3, median
verdicts, dissent quarantine, node score = mean. Scenarios are optional: an
empty benchmark falls back to one generic harness review (`"generic": true`).

## Environment

| Variable              | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`        | Neon Postgres URL (`.env.development.local` locally)                 |
| `GRAFFILAB_API_KEY`   | Model API key for eval + judging (GraffiLab model endpoint)          |
| `GRAFFILAB_BASE_URL`  | Endpoint override (default `https://llm.grafilab.ai/v1`)             |
| `GRAFFILAB_MODEL`     | Default model (default `grafilab/deepseek-v4-flash`)                 |
| `JUDGE_MODEL`         | Single-judge override (defaults to the provider model)               |
| `JUDGE_MODELS`        | Council lineup (default: qwen, glm-5.3, deepseek-v4-pro, hy3, gemma) |
| `DEEPSEEK_API_KEY`    | Override credential (wins when set; DeepSeek endpoint/model apply)   |
| `ALLOW_DSH_SPAWN`     | Boot literal dsh web UI locally (`=1`; never on hosted)              |
| `NEXT_PUBLIC_API_URL` | Frontend → API base URL if split                                     |

Never commit secrets. See `.env.example`.

## Tests and checks

```bash
uv run pytest                                     # backend (sqlite, no network)
uv run ruff format . && uv run ruff check .       # lint
```

## For agents

`AGENTS.md` is the full contributor guide: data model, MCP interface
(incl. `parent_revision` + `suggested_changes`), council scoring, regression
rule, evaluation flow, database schema, and frontend rules.
