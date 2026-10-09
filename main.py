import os

from openai import OpenAI


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY is not set. Export it, then run `uv run python main.py`.")
        return

    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model="gpt-4o-mini",
        input="Say hello from the Customer Support Harness Optimizer demo in one sentence.",
    )
    print(response.output_text)


if __name__ == "__main__":
    main()
