"""应用设置相关接口（目前仅：开机自启动）。"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.services import autostart

router = APIRouter(prefix="/api/settings", tags=["settings"])


class AutostartBody(BaseModel):
    enabled: bool


@router.get("/autostart")
def get_autostart():
    """查询自启动状态：enabled=当前是否已开启，available=当前形态是否支持。"""
    return {
        "enabled": autostart.get_enabled(),
        "available": autostart.is_available(),
    }


@router.put("/autostart")
def set_autostart(body: AutostartBody):
    """开启/关闭自启动。开发模式（python run.py）下不可用，返回 409。"""
    if not autostart.is_available():
        from fastapi import HTTPException

        raise HTTPException(409, "仅在安装版（exe）下支持开机自启动")
    ok = autostart.set_enabled(body.enabled)
    return {
        "applied": ok,
        "enabled": autostart.get_enabled(),
        "available": True,
    }
