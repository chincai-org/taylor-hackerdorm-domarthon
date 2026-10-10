from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env.development.local",
        env_ignore_empty=True,
        extra="ignore",
    )

    PROJECT_NAME: str = "Vercel + FastAPI"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"
    DATABASE_URL: str

    # DeepSeek (OpenAI-compatible) chat settings.
    DEEPSEEK_API_KEY: str | None = None
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com/v1"
    DEEPSEEK_MODEL: str = "deepseek-chat"
    DEEPSEEK_TIMEOUT_S: float = 120.0

    # GraffiLab AI API (OpenAI-compatible model endpoint). The deployed harness
    # targets https://llm.grafilab.ai/v1 with grafilab/* models, so a
    # Grafilab key is the expected credential; DEEPSEEK_* still wins when
    # set, preserving the documented local override path.
    GRAFFILAB_API_KEY: str | None = None
    GRAFFILAB_BASE_URL: str = "https://llm.grafilab.ai/v1"
    GRAFFILAB_MODEL: str = "grafilab/deepseek-v4-flash"

    # LLM judge settings (used to score new nodes right after creation).
    JUDGE_MODEL: str | None = None
    JUDGE_TIMEOUT_S: float = 30.0
    JUDGE_MAX_SCENARIOS: int = 20
    EVAL_CANDIDATE_TIMEOUT_S: float = 60.0
    EVAL_TOTAL_TIMEOUT_S: float = 90.0


settings = Settings()


def llm_provider() -> str | None:
    """Which credential set backs model calls: ``deepseek``, ``grafilab``, or None."""
    if (settings.DEEPSEEK_API_KEY or "").strip():
        return "deepseek"
    if (settings.GRAFFILAB_API_KEY or "").strip():
        return "grafilab"
    return None


def llm_api_key() -> str:
    if (settings.DEEPSEEK_API_KEY or "").strip():
        return settings.DEEPSEEK_API_KEY.strip()  # type: ignore[union-attr]
    return (settings.GRAFFILAB_API_KEY or "").strip()


def llm_base_url() -> str:
    if (settings.DEEPSEEK_API_KEY or "").strip():
        return settings.DEEPSEEK_BASE_URL
    return settings.GRAFFILAB_BASE_URL


def llm_model() -> str:
    if (settings.DEEPSEEK_API_KEY or "").strip():
        return settings.DEEPSEEK_MODEL
    return settings.GRAFFILAB_MODEL
