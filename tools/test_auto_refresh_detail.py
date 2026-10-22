"""R2 详情页自动更新验证：隔离服务 + 临时项目 + 无头 Chrome。

运行：.venv/Scripts/python.exe .workbuddy/tmp/verify-autorefresh-detail.py
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

REPO = r"D:/AI/Zcode_Workspace/local-project-archive-desktop"
TMP = os.path.join(REPO, ".workbuddy", "tmp")
HERE = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.dirname(os.path.abspath(__file__))
RUN_DIR = os.path.join(TMP, "autorefresh-run")
OUT_DIR = os.path.join(TMP, "autorefresh-shots")
PORT = 8441
DEBUG_PORT = 9441
BASE = f"http://127.0.0.1:{PORT}"
NODE = r"C:/Users/luckyzyb/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
CHROME = r"C:/Program Files/Google/Chrome/Application/chrome.exe"


def free_port():
    """挑一个真正可绑定的端口：本机存在被 Hyper-V 保留的端口段，固定端口会 bind 失败。"""
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"detail": e.read().decode()}


def _rmtree(path):
    if not os.path.isdir(path):
        return
    if os.getcwd().lower().startswith(os.path.abspath(path).lower()):
        os.chdir(REPO)
    shutil.rmtree(path, ignore_errors=True)
    if os.path.isdir(path):
        subprocess.run(["cmd", "/c", "rd", "/s", "/q", path], capture_output=True)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def git(path, *args):
    subprocess.run(["git", "-c", "user.name=Tracelight Test",
                    "-c", "user.email=test@example.com", *args],
                   cwd=path, check=True, capture_output=True)


def make_project(name):
    p = os.path.join(RUN_DIR, "samples", name)
    write(os.path.join(p, "README.md"), f"# {name}\n\n初始简介：第一版。\n")
    write(os.path.join(p, "package.json"),
          json.dumps({"name": name, "version": "1.0.0"}, ensure_ascii=False))
    write(os.path.join(p, "src", "a.py"), "print('a')\n")
    git(p, "init", "-q")
    git(p, "add", "-A")
    git(p, "commit", "-q", "-m", "feat: init")
    return p


def main():
    _rmtree(RUN_DIR)
    os.makedirs(RUN_DIR, exist_ok=True)
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    shutil.copytree(os.path.join(REPO, "app"), os.path.join(RUN_DIR, "app"),
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(os.path.join(REPO, "run.py"), os.path.join(RUN_DIR, "run.py"))

    sys.path.insert(0, RUN_DIR)
    os.chdir(RUN_DIR)
    import uvicorn
    from app.main import app as fastapi_app

    server = uvicorn.Server(uvicorn.Config(fastapi_app, host="127.0.0.1",
                                           port=PORT, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        time.sleep(0.2)
        try:
            if req("GET", "/api/health")[0] == 200:
                break
        except Exception:
            pass
    _, health = req("GET", "/api/health")
    assert os.path.normcase(health["data_path"]).startswith(
        os.path.normcase(os.path.join(RUN_DIR, "data"))), f"数据未隔离：{health['data_path']}"

    ids = {}
    for key in ("a", "b"):
        p = make_project(f"auto-detail-{key}")
        st, created = req("POST", "/api/projects", {"path": p})
        assert st in (200, 201), created
        ids[key] = created["id"]
    ids["path_a"] = os.path.join(RUN_DIR, "samples", "auto-detail-a")
    ids["path_b"] = os.path.join(RUN_DIR, "samples", "auto-detail-b")

    plan_path = os.path.join(TMP, "autorefresh-plan.json")
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump({"port": PORT, "debugPort": free_port(), "outDir": OUT_DIR,
                   "chrome": CHROME, **ids}, f, ensure_ascii=False, indent=2)

    r = subprocess.run([NODE, os.path.join(HERE, "test_auto_refresh_detail.mjs"), plan_path],
                       cwd=TMP, capture_output=True)
    print(r.stdout.decode("utf-8", "replace"))
    err = r.stderr.decode("utf-8", "replace")
    if err.strip():
        print("STDERR:", err[-3000:])

    server.should_exit = True
    time.sleep(0.8)
    _rmtree(RUN_DIR)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
