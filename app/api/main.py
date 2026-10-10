from fastapi import APIRouter

from app.api.routes import deepseek, dsh, harness, items, trees

api_router = APIRouter()
api_router.include_router(items.router)
api_router.include_router(deepseek.router)
api_router.include_router(dsh.router)
api_router.include_router(harness.router)
api_router.include_router(trees.router)
