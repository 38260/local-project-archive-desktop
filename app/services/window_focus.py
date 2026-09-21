"""桌面主窗口唤起：把窗口从「隐藏 / 最小化」状态真正带到前台。

为什么单独成一个模块：托盘菜单（desktop.py）与「二次启动」的 HTTP 接口
（app/main.py 的 /api/show-window）需要同一套唤起逻辑，共用一份可避免两处
行为漂移——这正是本模块诞生的原因，此前两处都只调 window.show()。

为什么不能只调 pywebview 的 window.show()：
  pywebview 的 WinForms 后端把 show() 实现为 Form.Show() + Form.Activate()，
  而 Form.Show() 只把 Visible 置真，**不改变 WindowState**。窗口若处于最小化
  状态，show() 之后依然是「可见但最小化」——实测 IsWindowVisible=1 且
  IsIconic=1，窗口并没有弹出来。用户看到的现象就是：点托盘图标、点托盘菜单
  里的功能项、点桌面/任务栏快捷方式，程序都「没反应」。
  这里在 show() 之后补一次 Win32 ShowWindow(SW_RESTORE) 强制还原，并把窗口
  置前，才算真正「弹出」。
"""
from __future__ import annotations

import ctypes
import logging
import os

logger = logging.getLogger("lpa")

# ShowWindow 命令码：SW_RESTORE 会显示窗口并激活，最小化/最大化时同时还原
_SW_RESTORE = 9

_USER32 = None
_KERNEL32 = None


def _user32():
    """返回带完整签名的 user32；非 Windows 或初始化失败返回 None。

    刻意使用独立的 WinDLL 实例，而不是 ctypes.windll.user32：windll 上的函数
    对象是全局共享的，在这里改 restype 会连带改变 desktop.py 里设置窗口图标的
    代码行为。独立实例把签名影响限制在本模块内。

    HWND 必须声明为 c_void_p：64 位下句柄是指针，而 ctypes 默认 restype 是
    c_int，会把句柄截断成错误的值，后续 ShowWindow / SetForegroundWindow 就会
    作用到别的窗口上（或干脆无效）。
    """
    global _USER32
    if _USER32 is not None:
        return _USER32 or None
    if os.name != "nt":
        _USER32 = False
        return None
    try:
        u = ctypes.WinDLL("user32", use_last_error=True)
        u.FindWindowW.restype = ctypes.c_void_p
        u.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
        u.GetForegroundWindow.restype = ctypes.c_void_p
        u.IsIconic.argtypes = [ctypes.c_void_p]
        u.IsIconic.restype = ctypes.c_int
        u.IsWindowVisible.argtypes = [ctypes.c_void_p]
        u.IsWindowVisible.restype = ctypes.c_int
        u.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        u.ShowWindow.restype = ctypes.c_int
        u.SetForegroundWindow.argtypes = [ctypes.c_void_p]
        u.SetForegroundWindow.restype = ctypes.c_int
        u.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        u.GetWindowThreadProcessId.restype = ctypes.c_uint32
        u.AttachThreadInput.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int]
        u.AttachThreadInput.restype = ctypes.c_int
        u.BringWindowToTop.argtypes = [ctypes.c_void_p]
        u.BringWindowToTop.restype = ctypes.c_int
        u.FlashWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        u.FlashWindow.restype = ctypes.c_int
        _USER32 = u
    except Exception as exc:
        logger.warning("user32 初始化失败，窗口唤起降级为 pywebview show()：%s", exc)
        _USER32 = False
    return _USER32 or None


def _kernel32():
    """返回带签名的 kernel32（用于取当前线程 id）；失败返回 None。

    同样用独立 WinDLL 实例，避免改动全局共享的 ctypes.windll 函数对象。
    """
    global _KERNEL32
    if _KERNEL32 is not None:
        return _KERNEL32 or None
    if os.name != "nt":
        _KERNEL32 = False
        return None
    try:
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetCurrentThreadId.restype = ctypes.c_uint32
        _KERNEL32 = k
    except Exception as exc:
        logger.warning("kernel32 初始化失败：%s", exc)
        _KERNEL32 = False
    return _KERNEL32 or None


def _native_hwnd(window) -> int:
    """直接从 pywebview 窗口对象取 HWND；取不到返回 0。

    这是首选方式：pywebview 在创建窗口时把 WinForms 窗体挂在 window.native 上，
    拿到的句柄精确无歧义。按标题 FindWindowW 只是兜底——标题可能重名（用户开了
    另一个副本、或调试用的探针窗口），按标题查会误操作到别的窗口。
    """
    native = getattr(window, "native", None)
    if native is None:
        return 0
    try:
        handle = native.Handle
    except Exception:
        return 0
    if handle is None:
        return 0
    for cast in (lambda h: h.ToInt64(), lambda h: int(h)):
        try:
            return int(cast(handle))
        except Exception:
            continue
    return 0


def _find_hwnd(title: str) -> int:
    """按标题查找顶层窗口句柄（兜底路径）；找不到返回 0。"""
    u = _user32()
    if not u or not title:
        return 0
    try:
        return int(u.FindWindowW(None, title) or 0)
    except Exception:
        return 0


def _activate(hwnd: int) -> bool:
    """把窗口置前。

    SetForegroundWindow 受系统前台锁限制：非前台进程调用时可能只是让任务栏
    按钮闪烁而不真正置前。被拦下时临时把自己的输入队列挂到当前前台线程，
    借它的权限重试一次。
    """
    u = _user32()
    if not u or not hwnd:
        return False
    try:
        u.BringWindowToTop(hwnd)
        if u.SetForegroundWindow(hwnd):
            return True
        fg = u.GetForegroundWindow()
        tid_fg = u.GetWindowThreadProcessId(fg, None) if fg else 0
        k = _kernel32()
        tid_me = k.GetCurrentThreadId() if k else 0
        if tid_fg and tid_me and tid_fg != tid_me:
            u.AttachThreadInput(tid_me, tid_fg, True)
            try:
                return bool(u.SetForegroundWindow(hwnd))
            finally:
                u.AttachThreadInput(tid_me, tid_fg, False)
    except Exception as exc:
        logger.debug("窗口置前失败（窗口已显示，仅未获焦点）：%s", exc)
    return False


def bring_to_front(window, title: str = "", log=None) -> bool:
    """把主窗口从隐藏 / 最小化状态唤到前台。

    :param window: pywebview 窗口对象
    :param title: 窗口标题（用于查找句柄）；留空则取 window.title
    :param log: 日志器，默认用本模块的
    :return: 是否至少完成了一次「显示 / 还原」动作

    全程不向上抛异常：唤起失败只记日志，绝不让托盘菜单或 HTTP 接口因此报错
    （托盘回调抛异常会让 pystray 静默吞掉，反而更难排查）。
    """
    log = log or logger
    shown = False

    # 1) 先走 pywebview 原生路径：处理「隐藏 → 显示」，并置位内部 shown 事件
    try:
        window.show()
        shown = True
    except Exception as exc:
        log.warning("window.show() 失败：%s", exc)

    u = _user32()
    if u is None:
        return shown

    hwnd = _native_hwnd(window) or _find_hwnd(
        title or getattr(window, "title", "") or "")
    if not hwnd:
        log.warning("未找到主窗口句柄，已退回 pywebview show()")
        return shown

    # 2) 关键补丁：Show() 不改变 WindowState，最小化的窗口必须显式还原。
    #    SW_RESTORE 同时覆盖「隐藏 → 显示」并带激活语义，两种情况一并处理。
    try:
        if u.IsIconic(hwnd) or not u.IsWindowVisible(hwnd):
            u.ShowWindow(hwnd, _SW_RESTORE)
            shown = True
    except Exception as exc:
        log.warning("窗口还原失败：%s", exc)

    # 3) 置前：窗口「显示了但压在别的窗口后面」同样会被当成没弹出
    if not _activate(hwnd):
        try:
            u.FlashWindow(hwnd, True)      # 兜底：任务栏按钮闪烁提示用户
        except Exception:
            pass
    return shown
