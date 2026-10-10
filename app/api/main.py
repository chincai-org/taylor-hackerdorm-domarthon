from fastapi import APIRouter

from app.api.routes import deepseek, items, pi

api_router = APIRouter()
api_router.include_router(items.router)
api_router.include_router(deepseek.router)
api_router.include_router(pi.router)
