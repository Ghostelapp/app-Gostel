from fastapi import APIRouter

from app.core.config import APP_NAME

router = APIRouter()

@router.get("/")
async def root():
    return {"app": APP_NAME, "version": "1.0.0", "status": "ok"}
