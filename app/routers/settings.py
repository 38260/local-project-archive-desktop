"""应用设置相关接口：通用键值设置（settings.json）与开机自启动。"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import autostart, settings_store

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# 通用设置（DATA_DIR/settings.json）
# ---------------------------------------------------------------------------

_MAX_KEYS = 64
_MAX_STR_LEN = 2000


@router.get("")
def get_settings():
    """读取全部设置（默认值与已保存值合并）。"""
    return settings_store.all()


@router.put("")
def put_settings(body: Dict[str, Any]):
    """批量写入设置。仅接受 JSON 原生值；返回写入后的完整配置。"""
    if not body:
        raise HTTPException(400, "请求体不能为空")
    if len(body) > _MAX_KEYS:
        raise HTTPException(400, f"单次最多写入 {_MAX_KEYS} 个设置项")
    for k, v in body.items():
        if not isinstance(k, str) or not k.strip():
            raise HTTPException(400, "设置键必须是非空字符串")
        if isinstance(v, str) and len(v) > _MAX_STR_LEN:
            raise HTTPException(400, f"设置值过长：{k}")
    return settings_store.update(body)


# ---------------------------------------------------------------------------
# 开机自启动（HKCU 注册表）
# ---------------------------------------------------------------------------

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
        raise HTTPException(409, "仅在安装版（exe）下支持开机自启动")
    ok = autostart.set_enabled(body.enabled)
    return {
        "applied": ok,
        "enabled": autostart.get_enabled(),
        "available": True,
    }
