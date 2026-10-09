import os
import time

from openai import APIStatusError, OpenAI, RateLimitError


def _load_dotenv(path=".env"):
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                os.environ.setdefault(k, v)
    except OSError:
        pass


_load_dotenv()

# -----------------------------
# OpenRouter client
# -----------------------------
api_key = os.getenv("OPENROUTER_API_KEY")
if not api_key:
    raise RuntimeError(
        "OPENROUTER_API_KEY missing. Run: "
        'export OPENROUTER_API_KEY="$(pi auth print-api-key --provider openrouter)"'
    )
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=api_key,
    default_headers={
        "HTTP-Referer": "http://localhost:5000",
        "X-Title": "Support Harness Optimizer",
    },
)

MODEL = "poolside/laguna-s-2.1:free"  # same free model as pi agent (models.json)
FALLBACK_MODELS = ["openrouter/free", "qwen/qwen3.8-27b:free"]
MAX_RETRIES = 3
RETRY_BASE_S = 5
SLEEP_BETWEEN_CALLS = 3

# -----------------------------
# Test cases
# -----------------------------
TEST_CASES = [
    {
        "id": 1,
        "customer_message": "I can't log into my Tencent account. It says password incorrect.",
        "expected_intent": "login_issue",
    },
    {
        "id": 2,
        "customer_message": "I was charged twice for the same order.",
        "expected_intent": "double_charge",
    },
    {
        "id": 3,
        "customer_message": "I want a refund for my purchase yesterday.",
        "expected_intent": "refund_request",
    },
    {
        "id": 4,
        "customer_message": "My account got locked after suspicious activity.",
        "expected_intent": "account_safety",
    },
]

# -----------------------------
# Baseline and improved prompts
# -----------------------------
BASELINE_SYSTEM = """You are a customer support agent.
Be polite and helpful.
"""

IMPROVED_SYSTEM = """You are a customer support agent for Tencent-style support.
Be polite, concise, and accurate.
Ask for missing details when needed.
Escalate billing, account safety, or unresolved issues.
Do not make up policy or promise outcomes you cannot guarantee.
"""


# -----------------------------
# Agent functions
# -----------------------------
def _chat_once(model: str, system_prompt: str, user_message: str) -> str:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=0.2,
        max_tokens=500,
        timeout=60,
    )
    content = response.choices[0].message.content or ""
    return content.strip()


def run_agent(system_prompt: str, user_message: str) -> str:
    assert system_prompt, "system_prompt empty"
    assert user_message, "user_message empty"
    models = [MODEL] + [m for m in FALLBACK_MODELS if m != MODEL]
    last_err: Exception | None = None
    for model in models:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                reply = _chat_once(model, system_prompt, user_message)
                time.sleep(SLEEP_BETWEEN_CALLS)
                return reply
            except RateLimitError as e:
                last_err = e
                time.sleep(RETRY_BASE_S * attempt)
            except APIStatusError as e:
                last_err = e
                if e.status_code is not None and e.status_code < 500:
                    break
                time.sleep(RETRY_BASE_S * attempt)
    raise RuntimeError(f"all models rate-limited/failed: {last_err}")


def baseline_agent(message: str) -> str:
    return run_agent(BASELINE_SYSTEM, message)


def improved_agent(message: str) -> str:
    return run_agent(IMPROVED_SYSTEM, message)


# -----------------------------
# Simple scoring
# -----------------------------
def score_response(ticket, response):
    text = response.lower()
    score = {
        "correctness": 3,
        "tone": 3,
        "resolution": 3,
        "escalation_quality": 3,
        "policy_compliance": 3,
    }

    if any(w in text for w in ["sorry", "thank you", "understand"]):
        score["tone"] += 1

    if any(
        w in text
        for w in [
            "reset",
            "verify",
            "transaction",
            "escalate",
            "details",
            "support team",
        ]
    ):
        score["resolution"] += 1

    if any(w in text for w in ["escalate", "human agent", "support team"]):
        score["escalation_quality"] += 1

    if any(w in text for w in ["guaranteed refund", "account recovered", "we will fix it now"]):
        score["policy_compliance"] -= 2

    if ticket["expected_intent"] == "login_issue" and any(
        w in text for w in ["reset password", "password reset"]
    ):
        score["correctness"] += 1
    if ticket["expected_intent"] == "double_charge" and any(
        w in text for w in ["billing", "transaction", "escalate"]
    ):
        score["correctness"] += 1
    if ticket["expected_intent"] == "refund_request" and any(
        w in text for w in ["refund", "eligibility", "policy"]
    ):
        score["correctness"] += 1
    if ticket["expected_intent"] == "account_safety" and any(
        w in text for w in ["security", "suspicious", "reset password"]
    ):
        score["correctness"] += 1

    for k in score:
        score[k] = max(1, min(5, score[k]))

    score["total"] = sum(score.values())
    return score


# -----------------------------
# Evaluation
# -----------------------------
def evaluate_agent(agent_fn, test_cases):
    results = []
    for case in test_cases:
        try:
            reply = agent_fn(case["customer_message"])
            score = score_response(case, reply)
        except Exception as e:
            reply = f"[ERROR after retries: {e}]"
            score = {
                "correctness": 1,
                "tone": 1,
                "resolution": 1,
                "escalation_quality": 1,
                "policy_compliance": 1,
                "total": 5,
            }
        results.append(
            {
                "id": case["id"],
                "input": case["customer_message"],
                "reply": reply,
                "score": score,
            }
        )
    return results


def summarize(results):
    keys = [
        "correctness",
        "tone",
        "resolution",
        "escalation_quality",
        "policy_compliance",
        "total",
    ]
    return {k: round(sum(r["score"][k] for r in results) / len(results), 2) for k in keys}


def compare_runs(baseline_results, improved_results):
    print("\nMETRIC           BASELINE   IMPROVED   DELTA")
    print("---------------------------------------------")
    for key in [
        "correctness",
        "tone",
        "resolution",
        "escalation_quality",
        "policy_compliance",
        "total",
    ]:
        b = sum(r["score"][key] for r in baseline_results) / len(baseline_results)
        i = sum(r["score"][key] for r in improved_results) / len(improved_results)
        print(f"{key:<16} {b:>8.2f}   {i:>8.2f}   {i - b:>+5.2f}")


def demo_case(ticket):
    print("\n" + "=" * 60)
    print("TICKET:", ticket["customer_message"])

    b = baseline_agent(ticket["customer_message"])
    i = improved_agent(ticket["customer_message"])

    b_score = score_response(ticket, b)
    i_score = score_response(ticket, i)

    print("\nBASELINE:")
    print(b)
    print("Score:", b_score["total"])

    print("\nIMPROVED:")
    print(i)
    print("Score:", i_score["total"])

    if i_score["total"] > b_score["total"]:
        print("\nVERDICT: Improved version wins")
    else:
        print("\nVERDICT: No improvement")


# -----------------------------
# Main
# -----------------------------
if __name__ == "__main__":
    baseline_results = evaluate_agent(baseline_agent, TEST_CASES)
    improved_results = evaluate_agent(improved_agent, TEST_CASES)

    compare_runs(baseline_results, improved_results)

    for case in TEST_CASES[:3]:
        demo_case(case)
