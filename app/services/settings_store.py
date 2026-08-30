"""通用设置持久化层：DATA_DIR/settings.json。

除开机自启动（注册表）与主题（浏览器 localStorage）外，
其余用户偏好统一存这里：随用户数据目录走，重装程序不丢。

设计约定：
  - 所有已知键在 DEFAULTS 中登记默认值（也是前端的取值字典）；
  - 文件损坏 / 缺失时静默回退默认值，绝不让设置读取抛异常；
  - 写入用「临时文件 + os.replace」，中断也不会留下半截文件。
"""
from __future__ import annotations

import json
import logging
import os
import tempfile

from app.config import DATA_DIR

logger = logging.getLogger(__name__)

# 已知设置键与默认值（新增设置项时在此登记）
DEFAULTS: dict = {
    # 备份
    "backup.enabled": True,      # 启动时自动备份数据库
    "backup.keep": 10,           # 保留最近几份备份
    # 外部编辑器（打开项目用）：空 = 自动找 code 命令
    "editor.command": "",
    # 批量扫描
    "scan.default_depth": 3,     # 默认扫描深度
    "scan.last_root": "",        # 记住上次扫描根目录
    "scan.refresh_on_start": False,  # 启动时后台校验路径是否丢失
    # 录入默认值
    "add.default_status": "进行中",
    "add.default_category": "",
    # 列表偏好（废弃=彻底不要的项目，默认隐藏；归档始终展示）
    "ui.show_discarded_default": False,
    # 详情页
    "commits.limit": 200,            # 提交记录单次加载数（后端上限 200）
    "ui.heatmap_weeks": 53,          # 提交热力图范围（26=半年 / 53=一年）
    # 导出
    "export.html_include_notes": True,  # 导出 HTML 是否包含笔记与变更日志
    # 快速启动
    "launch.confirm": True,          # 点击启动按钮先弹确认框展示完整命令
    # 桌面行为
    "app.start_minimized": False,    # 自启动/启动时不弹窗口（配合托盘）
    "tray.close_to_tray": False,     # 关闭按钮最小化到托盘而不是退出
    "window.geometry": None,         # 窗口大小/位置 {"w","h","x","y"}
}


def _path():
    return DATA_DIR / "settings.json"


def all() -> dict:
    """全部设置（默认值 + 已保存值合并）。"""
    data = dict(DEFAULTS)
    try:
        with open(_path(), encoding="utf-8") as f:
            stored = json.load(f)
        if isinstance(stored, dict):
            data.update({k: v for k, v in stored.items() if isinstance(k, str)})
    except OSError:
        pass  # 尚未保存过设置，用默认值即可
    except ValueError as exc:
        logger.warning("settings.json 已损坏，使用默认设置：%s", exc)
    return data


def get(key: str, default=None):
    """读单个设置；未知键返回 default。"""
    return all().get(key, default)


def update(pairs: dict) -> dict:
    """批量写入设置并返回写入后的完整配置。"""
    data = all()
    for k, v in pairs.items():
        if isinstance(k, str) and k:
            data[k] = v
    _write(data)
    return data


def set(key: str, value) -> None:
    """写单个设置。"""
    update({key: value})


def _write(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), suffix=".settings.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path())
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
