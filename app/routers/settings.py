"""应用设置相关接口：通用键值设置（settings.json）、备份管理与开机自启动。"""
from __future__ import annotations

import shutil
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import BACKUP_DIR, DB_PATH, _backup_db, backup_file_name_ok
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
# 数据库备份管理（data/backups/）
# ---------------------------------------------------------------------------

def _require_backup(name: str):
    if not backup_file_name_ok(name):
        raise HTTPException(400, "备份文件名不合法")
    f = BACKUP_DIR / name
    if not f.is_file():
        raise HTTPException(404, f"备份不存在：{name}")
    return f


@router.get("/backups")
def list_backups():
    """备份文件列表（按时间倒序）。"""
    items = []
    if BACKUP_DIR.is_dir():
        for f in sorted(BACKUP_DIR.glob("projects-*.db"), reverse=True):
            try:
                st = f.stat()
            except OSError:
                continue
            items.append({"name": f.name, "size": st.st_size,
                          "mtime": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat()})
    return {"backups": items, "auto_enabled": bool(settings_store.get("backup.enabled", True)),
            "keep": settings_store.get("backup.keep", 10)}


@router.post("/backups")
def create_backup():
    """立即备份当前数据库（无视"自动备份"开关与"无变化跳过"）。"""
    name = _backup_db(force=True)
    if not name:
        raise HTTPException(502, "备份失败：数据库文件不存在或不可读，详情见日志")
    return {"ok": True, "name": name}


class BackupNameBody(BaseModel):
    name: str


@router.post("/backups/restore")
def restore_backup(body: BackupNameBody):
    """用指定备份覆盖当前数据库。

    连接按请求开关，覆盖后新请求立即使用恢复的数据；恢复前先把当前库备份一份，
    误操作还能找回。
    """
    src = _require_backup(body.name)
    # 先给当前库留一份保险（恢复错了可以回滚）
    pre = _backup_db(force=True)
    try:
        shutil.copy2(src, DB_PATH)
    except OSError as exc:
        raise HTTPException(502, f"恢复失败：{exc}")
    return {"ok": True, "restored_from": body.name, "safety_backup": pre,
            "note": "已恢复，请刷新页面查看数据"}


@router.delete("/backups")
def delete_backup(body: BackupNameBody):
    """删除指定备份文件。"""
    f = _require_backup(body.name)
    try:
        f.unlink()
    except OSError as exc:
        raise HTTPException(502, f"删除失败：{exc}")
    return {"ok": True, "deleted": body.name}


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
