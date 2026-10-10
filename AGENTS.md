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
├── server/
│   ├── main.py              # FastAPI app; mounts MCP + REST routers
│   ├── mcp_server.py        # MCP tool definitions
│   ├── api.py               # REST endpoints for the frontend
│   ├── db.py                # DB setup + repository functions
│   ├── models.py            # Tree, Node, BenchmarkResult schemas
│   ├── evaluator.py         # Runs PI against a benchmark, scores result
│   ├── benchmarks/          # Benchmark definitions (customer support)
│   └── tests/
├── web/                     # Frontend (Vercel)
├── app/
│   └── db/
│       ├── engine.py        # Engine, sessions, and table creation
│       ├── models.py        # Tree, Node, and Benchmark tables
│       └── repository.py    # Database helper functions
└── scripts/                 # Seed data, local dev helpers
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

# Or use the development entry point
uv run python main.py

# Create the local Neon Postgres schema
uv run python -c "from app.db import create_tables; create_tables()"

# Format and lint
uv run ruff format .
uv run ruff check .

# Run tests when test files are present
uv run pytest
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
