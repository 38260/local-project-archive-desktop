"""R4 真实桌面壳（pywebview / WebView2）恢复验证。

验证链路（不依赖 CDP / evaluate_js，全部走可观测的副作用）：
  1. 窗口最小化 → POST /api/show-window（托盘「显示窗口」调用的同一 bring_to_front）恢复；
  2. 恢复后前端收到 tlOnWindowResume，发起 POST /api/refresh 并重新拉详情；
  3. 外部改 README 后，数据库里的 auto_meta.intro 随恢复刷新更新。

隔离手段（绝不打扰正在运行的正式实例）：
  - 整份源码复制到 .workbuddy/tmp/desktop-resume/ 运行，数据目录随之隔离；
  - 副本 desktop.py 里把互斥体名与窗口标题改成唯一值，避免单实例锁把本次启动
    判成「二次启动」而去唤出正式窗口；
  - 副本初始 URL 直接指向 /project/1（测试库唯一项目），窗口一打开就是详情页。

运行：.venv/Scripts/python.exe tools/test_desktop_resume.py
"""
import ctypes
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_DIR = os.path.join(REPO, ".workbuddy", "tmp", "desktop-resume")
LOG_OUT = os.path.join(REPO, ".workbuddy", "tmp", "desktop-resume.log")
TITLE = "归迹 · tracelight VERIFY"
MUTEX = "tracelight_SingleInstanceMutex_VERIFY"
PY = os.path.join(REPO, ".venv", "Scripts", "python.exe")
PORT = 8481

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name}" + (f"  -> {detail}" if detail else ""))


def _rmtree(path):
    if not os.path.isdir(path):
        return
    if os.getcwd().lower().startswith(os.path.abspath(path).lower()):
        os.chdir(REPO)
    shutil.rmtree(path, ignore_errors=True)
    if os.path.isdir(path):
        subprocess.run(["cmd", "/c", "rd", "/s", "/q", path], capture_output=True)


def req(method, path, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}" + path, data=data,
                               method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"detail": e.read().decode()}


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _patch_lines(path, anchor, insert_lines, before_decorator=False):
    """在包含 anchor 的行之前插入若干行（仅测试副本使用）。"""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines(keepends=True)
    for i, ln in enumerate(lines):
        if anchor in ln:
            at = i
            if before_decorator and i > 0 and lines[i - 1].lstrip().startswith("@app.middleware"):
                at = i - 1
            lines.insert(at, "".join(x + "\n" for x in insert_lines))
            break
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("".join(lines))


def prepare():
    _rmtree(RUN_DIR)
    os.makedirs(RUN_DIR, exist_ok=True)
    for name in ("app", "assets"):
        shutil.copytree(os.path.join(REPO, name), os.path.join(RUN_DIR, name),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("run.py", "desktop.py"):
        shutil.copy2(os.path.join(REPO, name), os.path.join(RUN_DIR, name))

    p = os.path.join(RUN_DIR, "desktop.py")
    src = open(p, encoding="utf-8").read()
    src = src.replace('WINDOW_TITLE = "归迹 · tracelight"', f'WINDOW_TITLE = "{TITLE}"')
    src = src.replace('MUTEX_NAME = "tracelight_SingleInstanceMutex"', f'MUTEX_NAME = "{MUTEX}"')
    src = src.replace(
        '_LEGACY_MUTEX_NAMES = ("Tracelight_SingleInstanceMutex", '
        '"LocalProjectArchive_SingleInstanceMutex")', "_LEGACY_MUTEX_NAMES = ()")
    # 窗口初始就停在详情页（测试库只有 id=1 一个项目）
    src = src.replace('    url = f"http://{HOST}:{port}"\n',
                      '    url = f"http://{HOST}:{port}/project/1"\n')
    with open(p, "w", encoding="utf-8") as f:
        f.write(src)

    # 副本内注入两个诊断探针（仅测试副本，产品代码不含）：
    #   1) /api/refresh 调用记录 —— desktop.py 的 uvicorn 用 warning 级，access log 不落盘；
    #   2) 全量 HTTP 请求记录 —— 判断 WebView2 到底有没有加载页面。
    _patch_lines(os.path.join(RUN_DIR, "app", "routers", "refresh.py"),
                 "return refresh.request(body.ids, force=body.force, source=body.source)",
                 [
                     "    try:  # [verify] 刷新调用记录",
                     "        from app.config import DATA_DIR as _DD",
                     "        import time as _t",
                     '        with open(_DD / "refresh_hits.log", "a", encoding="utf-8") as _f:',
                     '            _f.write(f"{_t.time()}|{body.source}|{body.ids}" + "\\n")',
                     "    except OSError:",
                     "        pass",
                 ])
    _patch_lines(os.path.join(RUN_DIR, "app", "main.py"),
                 "async def _origin_guard(request, call_next):",
                 [
                     '@app.middleware("http")',
                     "async def _verify_hits(request, call_next):",
                     "    resp = await call_next(request)",
                     "    try:  # [verify] HTTP 请求记录（含状态码与 query）",
                     "        from app.config import DATA_DIR as _D",
                     '        with open(_D / "http_hits.log", "a", encoding="utf-8") as _f:',
                     '            q = ("?" + request.url.query) if request.url.query else ""',
                     '            _f.write(str(resp.status_code) + " " + request.method + " " + request.url.path + q + "\\n")',
                     "    except OSError:",
                     "        pass",
                     "    return resp",
                     "",
                     "",
                 ], before_decorator=True)

    # 副本里给页面注入错误上报：JS 任何早期异常都会被记录，便于定位 WebView2 环境差异
    pp = os.path.join(RUN_DIR, "app", "static", "project.html")
    psrc = open(pp, encoding="utf-8").read()
    hook = (
        "<script>\n"
        "(function () {\n"
        "  try { fetch('/api/_boot?ua=' + encodeURIComponent(String(navigator.userAgent || '').slice(0, 120))); } catch (e) {}\n"
        "  function report(m) {\n"
        "    try {\n"
        "      var url = '/api/_client_error?m=' + encodeURIComponent(String(m).slice(0, 300));\n"
        "      if (navigator.sendBeacon) navigator.sendBeacon(url); else fetch(url, { method: 'POST' });\n"
        "    } catch (e) {}\n"
        "  }\n"
        "  window.addEventListener('error', function (e) {\n"
        "    report((e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));\n"
        "  });\n"
        "  window.addEventListener('unhandledrejection', function (e) {\n"
        "    report('promise: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));\n"
        "  });\n"
        "})();\n"
        "</script>\n"
    )
    psrc = psrc.replace("</head>", hook + "</head>", 1)
    with open(pp, "w", encoding="utf-8") as f:
        f.write(psrc)

    proj = os.path.join(RUN_DIR, "samples", "desktop-demo")
    write(os.path.join(proj, "README.md"), "# desktop-demo\n\n初始简介：桌面恢复验证。\n")
    write(os.path.join(proj, "package.json"),
          json.dumps({"name": "desktop-demo", "version": "1.0.0"}))
    subprocess.run(["git", "init", "-q"], cwd=proj, capture_output=True)
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@e.com", "add", "-A"],
                   cwd=proj, capture_output=True)
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@e.com",
                    "commit", "-q", "-m", "feat: init"], cwd=proj, capture_output=True)
    return proj


def seed_db(proj):
    """启动前把项目写进隔离库（等价于 POST /api/projects，避免依赖运行中的服务）。"""
    code = f"""
import json, os, sys
sys.path.insert(0, {RUN_DIR!r})
os.chdir({RUN_DIR!r})
from app.db import init_db, get_db
from app.services import parser
init_db()
parsed = parser.parse_project({proj!r})
with get_db() as conn:
    conn.execute(
        "INSERT INTO projects (path, name, alias, category, status, tags, auto_meta, "
        "fs_created, fs_modified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ({proj!r}, "desktop-demo", "", "", "进行中",
         json.dumps(parsed["auto_meta"]["tech_tags"], ensure_ascii=False),
         json.dumps(parsed["auto_meta"], ensure_ascii=False),
         parsed["fs_created"], parsed["fs_modified"],
         "2026-01-01T00:00:00+08:00", "2026-01-01T00:00:00+08:00"))
"""
    r = subprocess.run([PY, "-c", code], cwd=RUN_DIR, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
    return r.returncode == 0


def db_intro() -> str:
    db = os.path.join(RUN_DIR, "data", "projects.db")
    for _ in range(20):
        try:
            con = sqlite3.connect(db, timeout=3)
            row = con.execute("SELECT auto_meta FROM projects WHERE id=1").fetchone()
            con.close()
            if row:
                return (json.loads(row[0] or "{}") or {}).get("intro") or ""
        except sqlite3.Error:
            pass
        time.sleep(0.25)
    return ""


def refresh_hits():
    """副本内 /api/refresh 的调用记录（时间|source|ids）。"""
    p = os.path.join(RUN_DIR, "data", "refresh_hits.log")
    try:
        with open(p, encoding="utf-8") as f:
            return [ln.strip() for ln in f if ln.strip()]
    except OSError:
        return []


def window_handle(pid=None):
    """找测试窗口。

    优先按唯一标题（VERIFY 后缀）精确匹配——这是最稳的方式；
    PID 不可靠：venv 的 python.exe 是启动器，真正的解释器是它的子进程，
    窗口属于子进程而不是 Popen 返回的 pid。
    """
    u = ctypes.WinDLL("user32", use_last_error=True)
    u.FindWindowW.restype = ctypes.c_void_p
    u.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    u.IsWindowVisible.argtypes = [ctypes.c_void_p]
    u.IsIconic.argtypes = [ctypes.c_void_p]
    u.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    hwnd = u.FindWindowW(None, TITLE)
    if hwnd:
        return hwnd, u
    # 兜底：枚举所有可见窗口，取标题包含 VERIFY 的那个（页面改标题时仍能命中）
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    u.EnumWindows.argtypes = [WNDENUMPROC, ctypes.c_void_p]
    u.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    u.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    hits = []

    def _cb(h, _lparam):
        n = u.GetWindowTextLengthW(h)
        if n:
            buf = ctypes.create_unicode_buffer(n + 2)
            u.GetWindowTextW(h, buf, n + 2)
            if "VERIFY" in buf.value and u.IsWindowVisible(h):
                hits.append(h)
        return True

    u.EnumWindows(WNDENUMPROC(_cb), None)
    print(f"  [diag] 按标题兜底命中：{hits}")
    return (hits[0] if hits else None), u


def wait_window(timeout=25):
    """等窗口出现：pywebview 初始化 WebView2 需要几秒，health 就绪不代表窗口已建好。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd, u = window_handle()
        if hwnd:
            return hwnd, u
        time.sleep(0.5)
    return None, ctypes.WinDLL("user32", use_last_error=True)


def main():
    proj = prepare()
    if not seed_db(proj):
        check("隔离库初始化", False)
        return 1
    check("隔离库初始化（id=1）", db_intro() != "", db_intro())

    log = open(LOG_OUT, "w", encoding="utf-8")
    env = dict(os.environ)
    # WebView2 走系统代理时 127.0.0.1 也可能被转发（本机代理会 502），加载不出页面
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--no-proxy-server"
    proc = subprocess.Popen([PY, "desktop.py", "--port", str(PORT)], cwd=RUN_DIR,
                            env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(80):
            time.sleep(0.5)
            try:
                if req("GET", "/api/health")[0] == 200:
                    break
            except Exception:
                pass
        else:
            print("桌面壳服务未启动，app.log：")
            print(open(os.path.join(RUN_DIR, "data", "app.log"), encoding="utf-8").read()[-2000:])
            return 1
        _, health = req("GET", "/api/health")
        check("桌面壳服务已启动且数据隔离",
              os.path.normcase(health["data_path"]).startswith(
                  os.path.normcase(os.path.join(RUN_DIR, "data"))), health["data_path"])

        # 等窗口与页面加载完成（详情页会自动发起一次刷新）
        hwnd, u = wait_window(25)
        check("找到测试窗口（唯一 VERIFY 标题）", bool(hwnd), str(hwnd))
        if not hwnd:
            print("--- app.log 尾部 ---")
            try:
                print(open(os.path.join(RUN_DIR, "data", "app.log"),
                           encoding="utf-8").read()[-1500:])
            except OSError:
                pass
        first = False
        for _ in range(60):
            time.sleep(0.5)
            if refresh_hits():
                first = True
                break
        check("进入详情页触发自动刷新", first, f"hits={refresh_hits()[:2]}")
        if not first:
            hp = os.path.join(RUN_DIR, "data", "http_hits.log")
            try:
                print("  [diag] HTTP 请求：\n" + open(hp, encoding="utf-8").read()[-2000:])
            except OSError as exc:
                print("  [diag] 没有任何 HTTP 请求落盘：", exc)
        check("窗口初始可见且未最小化",
              bool(hwnd) and u.IsWindowVisible(hwnd) == 1 and u.IsIconic(hwnd) == 0)

        print("  等待 31 秒冷却窗口…")
        time.sleep(31)
        intro_before = db_intro()
        hits_before = len(refresh_hits())

        # 外部修改 + 最小化
        write(os.path.join(proj, "README.md"), "# desktop-demo\n\n恢复后应看到的新简介。\n")
        u.ShowWindow(hwnd, 6)          # SW_MINIMIZE
        time.sleep(1.2)
        check("窗口已最小化", u.IsIconic(hwnd) == 1, str(u.IsIconic(hwnd)))

        st, shown = req("POST", "/api/show-window")
        check("唤起接口返回成功（与托盘「显示窗口」同一路径）",
              st == 200 and shown.get("ok"), str(shown))
        time.sleep(1.5)
        check("窗口已从最小化恢复", u.IsIconic(hwnd) == 0, str(u.IsIconic(hwnd)))

        # 恢复后应出现新的刷新请求，并写入新简介
        refreshed = False
        for _ in range(40):
            time.sleep(0.5)
            if len(refresh_hits()) > hits_before:
                refreshed = True
                break
        check("恢复后前端再次发起刷新（tlOnWindowResume 生效）", refreshed,
              f"{hits_before} -> {len(refresh_hits())}")

        intro_after = ""
        for _ in range(40):
            time.sleep(0.5)
            intro_after = db_intro()
            if "恢复后应看到的新简介" in intro_after:
                break
        check("恢复后采集数据已更新（数据库 intro 变化）",
              "恢复后应看到的新简介" in intro_after,
              f"{intro_before!r} -> {intro_after!r}")

        last_hit = refresh_hits()[-1] if refresh_hits() else ""
        check("恢复后的刷新来自页面自动更新（source=auto）", "|auto|" in last_hit, last_hit)
    finally:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass
        log.close()
        time.sleep(1.5)
        _rmtree(RUN_DIR)

    print(f"\n===== 结果：PASS {PASS} / FAIL {FAIL} =====")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
