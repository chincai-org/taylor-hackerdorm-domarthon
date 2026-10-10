# Customer Support Harness Optimizer

Hackerdorm Dormathon project for systematically improving customer support agents with repeatable, data-driven evaluation.

## Problem
Support agents are often tuned by intuition, so quality can regress across ticket types, tone handling, escalation decisions, and policy adherence.

## Solution
Customer Support Harness Optimizer runs a baseline agent and candidate configurations against realistic support tickets, scores each response automatically, and highlights the best-performing setup.

## Architecture
1. **Baseline Agent**: Current prompt/config used as the control.
2. **Test Cases**: Curated support tickets covering common and edge-case scenarios.
3. **Scoring Harness**: Evaluates correctness, tone, resolution quality, escalation quality, and policy compliance.
4. **Improved Config**: Candidate prompt/tools/settings to test.
5. **Comparison Loop**: Runs both variants, compares scores, and feeds insights into the next iteration.

## Features
- Repeatable benchmark runs on realistic support tickets
- Multi-metric scoring with transparent category breakdowns
- Baseline vs improved side-by-side comparison
- Fast iteration loop for prompt/config tuning
- Python + OpenAI SDK template using `uv`

## How It Works
1. Define a baseline support agent configuration.
2. Provide representative ticket test cases.
3. Run baseline and improved configs through the same harness.
4. Score outputs automatically by category.
5. Compare aggregate and per-category results to choose the best config.

## Tech Stack
- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/) for project/dependency management
- OpenAI Python SDK (`openai`)

## Project Summary (Judging Form)
Customer Support Harness Optimizer improves support-agent quality by testing baseline and candidate configurations against realistic support tickets, then automatically scoring each output across correctness, tone, resolution, escalation quality, and policy compliance; this creates a fast, objective optimization loop that helps teams ship safer, more reliable customer support behavior.

## 1-Minute Demo Script
“Hi everyone, we built **Customer Support Harness Optimizer** for Hackerdorm Dormathon.  
Instead of tweaking support bots blindly, we evaluate them like engineers test software.  
We start with a baseline agent and a realistic ticket set—refunds, outages, account locks, and escalation-heavy cases.  
Then we run both baseline and improved configurations through the same scoring harness.  
Each response is graded on correctness, tone, resolution quality, escalation quality, and policy compliance.  
On this dashboard-style output, you can instantly see where the new config wins and where it still fails.  
That means faster iteration, safer launches, and measurable quality improvements before customers ever see a response.  
In short: we turn support-agent tuning from guesswork into a repeatable optimization workflow.”

## Sample Results
| Metric | Baseline | Improved | Delta |
|---|---:|---:|---:|
| Correctness | 78 | 89 | +11 |
| Tone | 74 | 91 | +17 |
| Resolution Quality | 72 | 86 | +14 |
| Escalation Quality | 69 | 88 | +19 |
| Policy Compliance | 81 | 94 | +13 |
| **Overall** | **74.8** | **89.6** | **+14.8** |

The improved configuration consistently outperforms baseline, with the largest gains in escalation quality and tone while preserving strong policy compliance.

## How to Run
```bash
# from repository root
uv sync
uv run ruff format .
uv run python main.py
```

Set your key before running model calls:

```bash
export OPENROUTER_API_KEY="your_openrouter_api_key_here"
```

## MCP endpoint

The FastAPI app exposes a Streamable HTTP MCP server at:

```text
http://127.0.0.1:5001/mcp/
```

Start the server with `uv run python main.py` or:

```bash
uv run uvicorn app.main:app --reload --port 5001
```

When deployed on Vercel, the production endpoint is (note the required trailing slash):

```text
https://taylor-hackerdorm-domarthon-tanzhiheng86gmailcoms-projects.vercel.app/mcp/
```

The template currently exposes one example tool, `get_support_item`. Replace
or add tools in [app/mcp_server.py](app/mcp_server.py). The endpoint uses the
official Python MCP SDK and stateless HTTP sessions, making it suitable for
local development and simple deployments.

> **Note:** The Vercel project must NOT have Deployment Protection covering
> production ("All Deployments" / "Only Production Deployments"), otherwise
> MCP clients receive a Vercel SSO redirect instead of the SSE stream and
> fail with "Invalid content type, expected text/event-stream". Use
> "Only Preview Deployments" or disabled protection.
