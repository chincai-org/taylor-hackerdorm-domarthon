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

    # Pi headless RPC (`pi --mode rpc`) settings.
    PI_BINARY: str = "pi"
    PI_MODEL: str | None = None
    PI_TIMEOUT_S: float = 120.0


settings = Settings()
