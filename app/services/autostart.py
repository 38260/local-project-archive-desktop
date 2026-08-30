"""开机自启动：Windows 用 HKCU Run 注册表键。

选择注册表而非启动文件夹快捷方式的原因：
  - HKCU 键不需要管理员权限（Startup 文件夹同样不用，但创建 .lnk 要走 COM）；
  - 任务管理器「启动应用」标签能看到这条记录，用户可自行禁用，符合预期；
  - 纯标准库 winreg，零额外依赖。

仅在 PyInstaller 冻结（exe）模式下有意义：开发模式（python run.py）没有
可注册的 exe，接口会返回 available=False，前端据此提示"仅安装版可用"。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "LocalProjectArchive"


def exe_command() -> str | None:
    """返回应写入注册表的自启动命令；非 Windows 或非冻结模式返回 None。"""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return None
    exe = Path(sys.executable)
    # 加引号，防止路径含空格（Program Files 常见）
    return f'"{exe}"'


def is_available() -> bool:
    """当前运行形态是否支持自启动（仅安装版 exe）。"""
    return exe_command() is not None


def get_enabled() -> bool:
    """是否已注册自启动，且指向的就是当前程序（防止被别的安装覆盖后误判）。"""
    cmd = exe_command()
    if cmd is None:
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return value == cmd
    except OSError:
        return False


def set_enabled(enabled: bool) -> bool:
    """开启/关闭自启动。返回操作是否成功。"""
    cmd = exe_command()
    if cmd is None:
        return False
    import winreg

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, cmd)
            else:
                try:
                    winreg.DeleteValue(key, VALUE_NAME)
                except FileNotFoundError:
                    pass  # 本来就没注册，视为成功
        return True
    except OSError:
        return False
