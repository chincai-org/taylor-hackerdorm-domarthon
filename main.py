import os

from openai import OpenAI

# -----------------------------
# OpenRouter client
# -----------------------------
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
    default_headers={
        "HTTP-Referer": "http://localhost:5000",
        "X-Title": "Support Harness Optimizer",
    },
)

MODEL = "openai/gpt-5.4-mini"  # change if needed

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
def run_agent(system_prompt: str, user_message: str) -> str:
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=0.2,
    )
    return response.choices[0].message.content.strip()


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

    if any(
        w in text
        for w in ["guaranteed refund", "account recovered", "we will fix it now"]
    ):
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
        reply = agent_fn(case["customer_message"])
        score = score_response(case, reply)
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
