"""桌面模式入口：后台线程跑 uvicorn，主线程开 pywebview 原生窗口。

用法：
  python desktop.py              # 开发模式：数据仍在仓库 data/，窗口用 pywebview
  python desktop.py --browser    # 强制用系统浏览器（pywebview 不可用时自动回退）
  python desktop.py --port 9000  # 指定端口（默认自动挑选空闲端口）

打包后由 PyInstaller 以本文件为入口，双击 exe 直接打开原生窗口，
数据写入 %LOCALAPPDATA%\\LocalProjectArchive，不随程序重装而丢失。
"""
from __future__ import annotations

import atexit
import ctypes
import os
import shutil
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

# ---- windowed 模式适配（模块级，须在任何可能访问 stdout/stderr 的库之前）----
# PyInstaller --noconsole 打包后 sys.stdout / sys.stderr 为 None：
# uvicorn 的彩色日志格式化器（ColourizedFormatter）构造时会访问
# sys.stdout.isatty()，直接抛 AttributeError，程序起不来。
# 补成 devnull 即可让一切正常，真实日志已由 setup_logging 落盘。
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")


# --------------------------------------------------------------------------
# 日志与异常兜底
# --------------------------------------------------------------------------
def setup_logging(data_dir: Path):
    """冻结后没有控制台，所有输出必须落盘，否则出问题无从排查。"""
    import logging

    log_file = data_dir / "app.log"
    logging.basicConfig(
        filename=str(log_file),
        level=logging.INFO,
        encoding="utf-8",
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return logging.getLogger("lpa"), log_file


def alert(title: str, msg: str) -> None:
    """冻结环境下用消息框兜底，避免用户只看到"双击没反应"。"""
    if getattr(sys, "frozen", False) and os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(0, msg[-1800:], title, 0x10)
        except Exception:
            pass


def install_excepthook(logger) -> None:
    def hook(etype, value, tb):
        msg = "".join(traceback.format_exception(etype, value, tb))
        logger.error("未捕获异常：\n%s", msg)
        alert("本地项目档案 - 出错了", msg)

    sys.excepthook = hook


# --------------------------------------------------------------------------
# 单实例
# --------------------------------------------------------------------------
MUTEX_NAME = "LocalProjectArchive_SingleInstanceMutex"
ERROR_ALREADY_EXISTS = 183

# 互斥体句柄必须持有到进程结束；一旦被回收，内核会认为实例已退出
_MUTEX_HANDLE = None


def _pid_alive(pid: int) -> bool:
    """非 Windows 平台的回退检测。

    Windows 上不能用这一套：PID 会被系统复用，进程死后其 PID 很快分配给别的进程，
    导致"程序明明没开却提示已在运行"。Windows 走下面的内核互斥体。
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        k32 = ctypes.windll.kernel32
        # BOOL 是 4 字节 int，不能声明为 c_bool（1 字节），否则参数错位
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        handle = k32.OpenProcess(0x1000, 0, pid)
        if handle:
            k32.CloseHandle(ctypes.c_void_p(handle))
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_single_instance(data_dir: Path, logger=None) -> bool:
    """保证只有一个实例在运行。返回 False 表示已有实例。

    Windows 用内核命名互斥体：进程崩溃时由系统自动释放，
    既不会留下"僵尸锁"，也不受 PID 复用影响。
    """
    global _MUTEX_HANDLE

    if os.name == "nt":
        k32 = ctypes.windll.kernel32
        k32.CreateMutexW.restype = ctypes.c_void_p
        k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        handle = k32.CreateMutexW(None, 0, MUTEX_NAME)
        if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            if handle:
                k32.CloseHandle(ctypes.c_void_p(handle))
            if logger:
                logger.info("检测到已有实例在运行，本次退出")
            return False
        _MUTEX_HANDLE = handle
        return True

    # 非 Windows：锁文件 + PID（尽力而为，写不了就放行）
    lock = data_dir / ".app.lock"
    if lock.exists():
        try:
            if _pid_alive(int(lock.read_text().strip())):
                if logger:
                    logger.info("检测到已有实例在运行，本次退出")
                return False
        except (ValueError, OSError):
            pass
        try:
            lock.unlink()          # 陈旧锁（上次异常退出残留）
        except OSError:
            pass
    try:
        lock.write_text(str(os.getpid()))
    except OSError:
        return True               # 不能因为锁写不了就打不开程序
    atexit.register(lambda: lock.unlink(missing_ok=True))
    return True


# --------------------------------------------------------------------------
# 旧版数据迁移
# --------------------------------------------------------------------------
def migrate_legacy_data(data_dir: Path, logger) -> None:
    """首次以 exe 运行时，把 exe 同目录下的旧 data/ 迁到用户目录。

    没有这一步，从源码版升级上来的用户会以为档案丢了。
    """
    if not getattr(sys, "frozen", False):
        return
    target = data_dir / "projects.db"
    if target.exists():
        return
    legacy = Path(sys.executable).parent / "data" / "projects.db"
    if not legacy.exists():
        return
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(legacy, target)
        shots = legacy.parent / "screenshots"
        if shots.is_dir():
            shutil.copytree(shots, data_dir / "screenshots", dirs_exist_ok=True)
        logger.info("已迁移旧档案：%s -> %s", legacy, target)
    except OSError as exc:
        logger.warning("旧档案迁移失败：%s", exc)


# --------------------------------------------------------------------------
# 服务与窗口
# --------------------------------------------------------------------------
def load_geometry(logger):
    """读取上次窗口大小/位置；无效或缺失时返回 None 用默认。"""
    try:
        from app.services import settings_store
        g = settings_store.get("window.geometry")
        if isinstance(g, dict) and all(isinstance(g.get(k), int) for k in ("w", "h")):
            return g
    except Exception as exc:
        logger.warning("读取窗口尺寸失败：%s", exc)
    return None


def save_geometry(window, logger):
    """关窗时记录窗口大小/位置，下次启动还原。"""
    try:
        from app.services import settings_store
        g = {"w": int(window.width), "h": int(window.height)}
        # x/y 部分平台/版本不可用，缺失则不还原位置
        try:
            g["x"], g["y"] = int(window.x), int(window.y)
        except (AttributeError, TypeError, ValueError):
            pass
        settings_store.set("window.geometry", g)
    except Exception as exc:
        logger.warning("保存窗口尺寸失败：%s", exc)


# 「退出」流程标记：托盘菜单点退出后，closing 事件不再拦截关窗
_EXITING = {"flag": False}


def _tray_available() -> bool:
    try:
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401
        return True
    except ImportError:
        return False


def _setting_true(key: str) -> bool:
    try:
        from app.services import settings_store
        return bool(settings_store.get(key))
    except Exception:
        return False


def start_tray(window, server, logger):
    """系统托盘：显示窗口 / 退出。在独立线程跑图标消息循环。"""
    try:
        import pystray
        from PIL import Image
    except ImportError:
        logger.warning("pystray/Pillow 不可用，托盘功能禁用")
        return None

    from app.config import BASE_DIR

    icon_file = BASE_DIR / "assets" / "app.ico"
    try:
        image = Image.open(icon_file) if icon_file.exists() \
            else Image.new("RGB", (64, 64), (9, 105, 218))
    except Exception:
        image = Image.new("RGB", (64, 64), (9, 105, 218))

    def show_window(icon, item):
        try:
            window.show()
        except Exception as exc:
            logger.warning("托盘唤起窗口失败：%s", exc)

    def quit_app(icon, item):
        _EXITING["flag"] = True
        server.should_exit = True
        try:
            icon.stop()
        except Exception:
            pass
        try:
            window.destroy()
        except Exception:
            os._exit(0)

    menu = pystray.Menu(
        pystray.MenuItem("显示窗口", show_window, default=True),
        pystray.MenuItem("退出", quit_app),
    )
    icon = pystray.Icon("LocalProjectArchive", image, "本地项目档案", menu)
    threading.Thread(target=icon.run, daemon=True).start()
    logger.info("系统托盘已启用")
    return icon


def wait_port(port: int, host: str = "127.0.0.1", timeout: float = 20.0) -> bool:
    """轮询到服务真正在监听再开窗口，否则会白屏。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as sock:
            sock.settimeout(0.5)
            if sock.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.1)
    return False


def icon_path():
    """窗口图标位置（冻结后随包分发在 _MEIPASS 下）。"""
    from app.config import BASE_DIR

    path = BASE_DIR / "assets" / "app.ico"
    return str(path) if path.exists() else None


def open_browser_window(url: str, server) -> None:
    """回退方案：用系统浏览器打开，并阻塞到服务退出。"""
    import webbrowser

    webbrowser.open(url)
    print(f"服务已启动：{url}  （Ctrl+C 停止）")
    try:
        while not server.should_exit:
            time.sleep(0.5)
    except KeyboardInterrupt:
        server.should_exit = True


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="本地项目档案管理系统（桌面模式）")
    parser.add_argument("--port", type=int, default=0, help="指定端口（默认自动挑选）")
    parser.add_argument("--browser", action="store_true", help="用系统浏览器打开")
    args = parser.parse_args()

    from app.config import DATA_DIR, HOST, pick_port

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logger, log_file = setup_logging(DATA_DIR)
    install_excepthook(logger)
    migrate_legacy_data(DATA_DIR, logger)

    if not acquire_single_instance(DATA_DIR, logger):
        alert("本地项目档案", "程序已经在运行了。")
        return 0

    port = args.port or pick_port()

    import uvicorn

    from app.main import app

    server = uvicorn.Server(
        uvicorn.Config(app, host=HOST, port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()

    if not wait_port(port):
        logger.error("服务未能在 20 秒内启动（端口 %s）", port)
        alert("本地项目档案", f"服务启动失败。\n日志位置：{log_file}")
        return 1

    url = f"http://{HOST}:{port}"
    logger.info("服务已启动：%s（数据目录：%s）", url, DATA_DIR)

    use_webview = not args.browser
    if use_webview:
        try:
            import webview
        except ImportError:
            logger.warning("pywebview 不可用，回退到系统浏览器")
            use_webview = False

    if not use_webview:
        open_browser_window(url, server)
        return 0

    # 窗口大小/位置：还原上次的（无效或缺失时用默认）
    geo = load_geometry(logger)
    width, height = 1440, 900
    pos_kwargs = {}
    if geo:
        width, height = geo["w"], geo["h"]
        if "x" in geo and "y" in geo:
            pos_kwargs = {"x": geo["x"], "y": geo["y"]}

    # 托盘行为：关闭=隐藏到托盘；配合「静默启动」可开机不弹窗
    tray_enabled = _tray_available() and _setting_true("tray.close_to_tray")
    start_hidden = tray_enabled and _setting_true("app.start_minimized")

    window = webview.create_window(
        "本地项目档案", url, width=width, height=height, min_size=(1024, 700),
        hidden=start_hidden, **pos_kwargs)
    if window is None:
        # 极少数环境下创建窗口会返回 None，不能让用户干等
        logger.error("pywebview 创建窗口失败，回退到系统浏览器")
        alert("本地项目档案", "无法创建应用窗口，已改用浏览器打开。")
        open_browser_window(url, server)
        return 0

    tray_icon = start_tray(window, server, logger) if tray_enabled else None

    if tray_enabled:
        # 有托盘时，关闭按钮 = 隐藏到托盘而不是退出（托盘菜单点退出才真退出）
        def _on_closing():
            if _EXITING["flag"]:
                return True          # 已在退出流程，放行关闭
            try:
                window.hide()
            except Exception:
                return True          # 隐藏失败就别拦着了
            return False             # 取消本次关闭
        window.events.closing += _on_closing

    # 关窗（真正退出）必须让服务退出，否则进程会残留成僵尸；顺带记住窗口位置
    def _on_closed():
        server.should_exit = True
        save_geometry(window, logger)
        if tray_icon is not None:
            try:
                tray_icon.stop()
            except Exception:
                pass
    window.events.closed += _on_closed

    webview.start(icon=icon_path(), debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
