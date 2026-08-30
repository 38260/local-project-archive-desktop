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
VALUE_NAME = "Tracelight"

# 改名前用过的注册表值名：读取时自动搬迁，写入时顺手清理
_LEGACY_VALUE_NAMES = ("LocalProjectArchive",)


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
    """是否已注册自启动，且指向的就是当前程序（防止被别的安装覆盖后误判）。

    兼容改名前的旧注册表项：发现旧项指向的就是当前程序时，自动把记录
    搬到新值名下并删除旧项——应用改名不应让用户重开一次自启动。
    """
    cmd = exe_command()
    if cmd is None:
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            try:
                value, _ = winreg.QueryValueEx(key, VALUE_NAME)
                return value == cmd
            except FileNotFoundError:
                pass
            for legacy in _LEGACY_VALUE_NAMES:
                try:
                    old, _ = winreg.QueryValueEx(key, legacy)
                except FileNotFoundError:
                    continue
                if old == cmd:
                    winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, cmd)
                    winreg.DeleteValue(key, legacy)
                    return True
        return False
    except OSError:
        return False


def self_heal(logger=None) -> None:
    """自启动项指向旧路径时（升级/搬移安装目录后），自动改指当前 exe。

    用户当初开启自启动的意图是「开机启动这个应用」，而不是「启动某个旧路径
    的旧版本」；不纠偏的话，每次登录都会拉起旧版，新版反而被单实例机制挡住。
    仅在注册表里已有条目（用户确实开过自启动）时改写，绝不擅自新增。
    """
    cmd = exe_command()
    if cmd is None:
        return
    import winreg

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            for name in (VALUE_NAME, *_LEGACY_VALUE_NAMES):
                try:
                    old, _ = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    continue
                if old != cmd:
                    winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, cmd)
                    if name != VALUE_NAME:
                        try:
                            winreg.DeleteValue(key, name)
                        except FileNotFoundError:
                            pass
                    if logger:
                        logger.info("自启动项已从旧路径改指当前程序：%s", cmd)
                return  # 只会有一个生效条目
    except OSError:
        pass


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
            # 顺手清掉改名前残留的旧值名，避免任务管理器里出现重复条目
            for legacy in _LEGACY_VALUE_NAMES:
                try:
                    winreg.DeleteValue(key, legacy)
                except FileNotFoundError:
                    pass
        return True
    except OSError:
        return False
