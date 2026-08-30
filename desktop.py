"""桌面模式入口：后台线程跑 uvicorn，主线程开 pywebview 原生窗口。

用法：
  python desktop.py              # 开发模式：数据仍在仓库 data/，窗口用 pywebview
  python desktop.py --browser    # 强制用系统浏览器（pywebview 不可用时自动回退）
  python desktop.py --port 9000  # 指定端口（默认自动挑选空闲端口）

打包后由 PyInstaller 以本文件为入口，双击 exe 直接打开原生窗口，
数据写入 %LOCALAPPDATA%\\Tracelight，不随程序重装而丢失。
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

# 窗口/托盘统一显示名（与任务栏、告警弹窗保持一致）
WINDOW_TITLE = "归迹拾光"


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
        alert("归迹拾光 - 出错了", msg)

    sys.excepthook = hook


# --------------------------------------------------------------------------
# 单实例
# --------------------------------------------------------------------------
MUTEX_NAME = "Tracelight_SingleInstanceMutex"
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


def activate_existing(logger=None) -> bool:
    """探测本机已在运行的实例，请求其显示主窗口。

    用于二次启动场景：窗口收进托盘或静默启动时，用户再双击 exe
    应该直接唤出窗口（应用惯例），而不是提示后让用户自己找。
    返回是否成功唤出。
    """
    import json as _json
    import urllib.request

    from app.config import APP_NAME

    for port in range(8300, 8311):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health",
                                        timeout=0.6) as resp:
                data = _json.loads(resp.read().decode())
            if data.get("app") != APP_NAME:
                continue
        except Exception:
            continue
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/show-window", method="POST",
                data=b"{}", headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                ok = bool(_json.loads(resp.read().decode()).get("ok"))
            if ok:
                if logger:
                    logger.info("已唤出已有实例窗口（端口 %s）", port)
                return True
        except Exception:
            continue
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


# 改名前的旧英文名：数据目录随之变化，新版首次运行需一次性迁移
_LEGACY_APP_TITLE = "LocalProjectArchive"


def migrate_renamed_data(data_dir: Path, logger) -> None:
    """应用英文名由 LocalProjectArchive 改为 Tracelight 后的一次性数据迁移。

    旧版 exe 把数据放在用户目录下以旧名命名的文件夹里；新版首次运行时
    若自己的数据库尚未生成，则把旧目录整体复制过来。复制而非移动：
    旧目录保留在原地作保险，迁移失败也能重试。
    """
    if not getattr(sys, "frozen", False):
        return
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA")
                    or (Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME")
                    or (Path.home() / ".local" / "share"))
    legacy = base / _LEGACY_APP_TITLE
    if not legacy.is_dir() or (data_dir / "projects.db").exists():
        return
    try:
        shutil.copytree(legacy, data_dir, dirs_exist_ok=True)
        logger.info("已迁移改名前的数据目录：%s -> %s", legacy, data_dir)
    except OSError as exc:
        logger.warning("改名前数据目录迁移失败：%s", exc)


# --------------------------------------------------------------------------
# 服务与窗口
# --------------------------------------------------------------------------
def load_geometry(logger):
    """读取上次窗口大小/位置；无效或缺失时返回 None 用默认。

    同步过滤异常值（历史版本曾把最小化时的 -25600 坐标写进设置）。
    """
    try:
        from app.services import settings_store
        g = settings_store.get("window.geometry")
        if isinstance(g, dict) and all(isinstance(g.get(k), int) for k in ("w", "h")) \
                and g["w"] >= 300 and g["h"] >= 300 \
                and g.get("x", 0) > -20000 and g.get("y", 0) > -20000:
            return g
    except Exception as exc:
        logger.warning("读取窗口尺寸失败：%s", exc)
    return None


def save_geometry(window, logger):
    """记录窗口大小/位置；窗口处于最小化/隐藏等异常状态时跳过。

    返回 True 表示已写入。pywebview 在窗口销毁或最小化时读尺寸会
    返回 None / 屏幕外坐标（-25600），这类值写入会导致下次启动还原出坏窗口。
    """
    try:
        from app.services import settings_store
        w, h = int(window.width), int(window.height)
        x, y = int(window.x), int(window.y)
        if w < 300 or h < 300 or x < -20000 or y < -20000:
            return False
        settings_store.set("window.geometry", {"w": w, "h": h, "x": x, "y": y})
        return True
    except Exception as exc:
        logger.warning("保存窗口尺寸失败：%s", exc)
        return False


def track_geometry(window, logger):
    """跟踪窗口大小/位置变化并防抖持久化。

    不在 closing/closed 时保存：那两个时机窗口已最小化或销毁，
    读到的几何不可靠（曾导致保存出 -25600 的屏幕外坐标）。
    """
    import threading

    timer = {"t": None}

    def _save():
        save_geometry(window, logger)

    def _schedule(*_args):
        if timer["t"] is not None:
            timer["t"].cancel()
        timer["t"] = threading.Timer(0.8, _save)
        timer["t"].daemon = True
        timer["t"].start()

    # 显示后记录初始几何；拖动/缩放过程中防抖保存，静止 0.8s 后落盘
    window.events.shown += _schedule
    window.events.resized += _schedule
    window.events.moved += _schedule


# 「退出」流程标记：托盘菜单点退出后，closing 事件不再拦截关窗
_EXITING = {"flag": False}


class JsBridge:
    """暴露给前端 JS 的桌面能力（通过 pywebview js_api，仅桌面窗口模式存在）。

    前端调用：await window.pywebview.api.select_folder()
    """

    def __init__(self, window):
        self._window = window

    def select_folder(self):
        """打开原生「选择文件夹」对话框，返回绝对路径字符串；取消返回空串。"""
        import webview
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            return ""
        return result[0] if isinstance(result, (list, tuple)) else str(result)


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
    icon = pystray.Icon("Tracelight", image, "归迹拾光", menu)
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


def set_app_identity() -> None:
    """注册独立 AppUserModelID：任务栏把本进程当独立应用，而不是挂在 python.exe 下。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        # 裸字符串会与全局 .ico 路径无关联，但必须与打包快捷方式的 AUMID 一致才完全生效
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("GuijiShiguang.Tracelight")
    except Exception:
        pass


def apply_window_icon(logger):
    """给窗口换上应用图标。

    开发模式下宿主是 python.exe（Anaconda 发行版），任务栏/标题栏会显示
    Jupyter 风格的 Python 默认图标；打包 exe 自带图标无此问题。这里用
    WM_SETICON 直接把 assets/app.ico 设给窗口，两端一致。
    """
    if os.name != "nt":
        return

    def _apply(title):
        try:
            import ctypes
            user32 = ctypes.windll.user32
            hwnd = user32.FindWindowW(None, title)
            if not hwnd:
                return False
            from app.config import BASE_DIR
            icon_file = str(BASE_DIR / "assets" / "app.ico")
            if not os.path.exists(icon_file):
                return False
            IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
            WM_SETICON, ICON_SMALL, ICON_BIG = 0x80, 0, 1
            hicon = user32.LoadImageW(None, icon_file, IMAGE_ICON, 0, 0,
                                      LR_LOADFROMFILE | 0x40)  # 0x40=LR_DEFAULTSIZE
            if not hicon:
                return False
            user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon)
            user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon)
            logger.info("窗口图标已设置")
            return True
        except Exception as exc:
            logger.warning("设置窗口图标失败：%s", exc)
            return False

    # 窗口显示后再设（句柄在创建后才稳定）；标题即窗口名
    def _on_shown(*_args):
        import threading
        threading.Timer(0.5, lambda: _apply(WINDOW_TITLE)).start()

    _apply(WINDOW_TITLE)          # 先试一次（多数情况窗口已就绪）
    try:
        import webview
        for w in webview.windows:
            w.events.shown += _on_shown
    except Exception:
        pass


def main() -> int:
    import argparse

    set_app_identity()
    parser = argparse.ArgumentParser(description="归迹拾光管理系统（桌面模式）")
    parser.add_argument("--port", type=int, default=0, help="指定端口（默认自动挑选）")
    parser.add_argument("--browser", action="store_true", help="用系统浏览器打开")
    args = parser.parse_args()

    from app.config import DATA_DIR, HOST, pick_port

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logger, log_file = setup_logging(DATA_DIR)
    install_excepthook(logger)
    # 数据迁移：先迁改名前的用户目录（较新），exe 旁旧 data/ 仅在目标仍为空时兜底
    migrate_renamed_data(DATA_DIR, logger)
    migrate_legacy_data(DATA_DIR, logger)

    if not acquire_single_instance(DATA_DIR, logger):
        # 已有实例在跑（窗口可能收在托盘/静默隐藏）——直接唤出它的窗口，
        # 而不是丢一句「已在运行」让用户自己去托盘里翻
        if activate_existing(logger):
            return 0
        alert("归迹拾光", "程序已经在运行了。\n"
              "若找不到窗口，请查看系统托盘（任务栏右下角，可能收在「^」溢出区里）。")
        return 0

    port = args.port or pick_port()

    import uvicorn

    from app.main import app

    server = uvicorn.Server(
        uvicorn.Config(app, host=HOST, port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()

    if not wait_port(port):
        logger.error("服务未能在 20 秒内启动（端口 %s）", port)
        alert("归迹拾光", f"服务启动失败。\n日志位置：{log_file}")
        return 1

    url = f"http://{HOST}:{port}"
    logger.info("服务已启动：%s（数据目录：%s）", url, DATA_DIR)

    use_webview = not args.browser
    if use_webview:
        try:
            import webview
            # pywebview 默认在 DownloadStarting 里 Cancel 掉一切下载（ALLOW_DOWNLOADS=False），
            # 「导出 HTML / 导出 JSON」等 attachment 下载会被静默吞掉，表现为点了没反应。
            # 开启后走系统保存对话框，默认落在用户下载目录。须在 webview.start() 前设置。
            webview.settings["ALLOW_DOWNLOADS"] = True
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
        WINDOW_TITLE, url, width=width, height=height, min_size=(1024, 700),
        hidden=start_hidden, **pos_kwargs)
    if window is None:
        # 极少数环境下创建窗口会返回 None，不能让用户干等
        logger.error("pywebview 创建窗口失败，回退到系统浏览器")
        alert(WINDOW_TITLE, "无法创建应用窗口，已改用浏览器打开。")
        open_browser_window(url, server)
        return 0

    # 任务栏/标题栏图标：开发模式宿主是 python.exe，不设会显示 Jupyter 风格默认图标
    apply_window_icon(logger)

    # 把主窗口挂到服务上：/api/show-window 借此唤出窗口（二次启动/托盘场景）
    app.state.main_window = window

    tray_icon = start_tray(window, server, logger) if tray_enabled else None

    # 窗口大小/位置：变化时防抖持久化（closing/closed 时机窗口已不可读，见 track_geometry）
    track_geometry(window, logger)

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

    # 关窗（真正退出）必须让服务退出，否则进程会残留成僵尸
    def _on_closed():
        server.should_exit = True
        if tray_icon is not None:
            try:
                tray_icon.stop()
            except Exception:
                pass
    window.events.closed += _on_closed

    # 暴露桌面能力给前端：原生「选择文件夹」对话框（手动录入/批量扫描用）。
    # 浏览器模式没有这个桥，前端按钮点击时降级为提示。
    # expose 是运行时注册（js_api 需在 create_window 时传入，彼时窗口引用还不存在）
    window.expose(JsBridge(window).select_folder)
    webview.start(icon=icon_path(), debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
