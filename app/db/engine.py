from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.db.models import Base


def _database_url() -> str:
    return settings.DATABASE_URL


def build_engine() -> Engine:
    url = _database_url()
    connect_args: dict[str, Any] = {}
    engine_kwargs: dict[str, Any] = {
        "future": True,
        "pool_pre_ping": True,
        "pool_size": 1,
        "max_overflow": 0,
    }

    return create_engine(url, connect_args=connect_args, **engine_kwargs)


engine = build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def create_tables() -> None:
    Base.metadata.create_all(bind=engine)
