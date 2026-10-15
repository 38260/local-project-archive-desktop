"""隔离实例测试台：复制源码到临时目录、起 uvicorn、造样例档案、跑外部命令。

用途：给浏览器回归脚本（tools/test_browser_fixes.cjs、tools/test_browser_r11.cjs）
提供一个「源码隔离 + 数据隔离」的实例，并生成它们需要的 state.json。

用法（在仓库根目录执行）：
  ./.venv/Scripts/python.exe tools/isolated_instance.py \
      --repo . --run "<要跑的命令>" [--cwd root] [--keep]

- 源码隔离：复制 app/、run.py、tools/ 到临时根目录，服务以该目录为 cwd 启动，
  数据目录因此落在 <root>/data/projects.db，绝不触碰正式库。
- 档案隔离：样例项目建在 <root>/samples/ 下，并写入 <root>/state.json。
- 传给 --run 的命令里可用 %TL_STATE% / %TL_BASE% / %TL_ROOT%（cmd 展开）。
- 结束即停服务、删临时目录（--keep 保留用于排障）。
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082")


def make_samples(root: Path):
    samples = root / "samples"

    def project(name, readme, extra=None):
        d = samples / name
        write(d / "README.md", readme)
        if extra:
            extra(d)
        return d

    def alpha_extra(d):
        write(d / "notes.md", "# Alpha 笔记\n\n用于文字选择验证的第二段文字。\n")
        (d / "flowchart.png").write_bytes(PNG_1PX)
        # 多语言 README：详情页面板右上角应出现版本切换条
        write(d / "README_EN.md",
              "# Alpha Project (English)\n\nEnglish readme body for language switching.\n\n"
              "[中文](README.md) | [English](README_EN.md)\n")
        write(d / "README.zh-TW.md",
              "# Alpha 專案（繁體）\n\n用於語言切換驗證的繁體中文說明。\n")

    def beta_extra(d):
        write(d / "package.json", json.dumps(
            {"name": "select-project-beta", "version": "0.1.0",
             "scripts": {"dev": "vite", "build": "vite build"},
             "devDependencies": {"vite": "^5.0.0"}}, indent=2))
        write(d / "docs" / "workflow.svg",
              '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">'
              '<rect width="120" height="60" fill="#e8f0fe"/></svg>')
        write(d / "src" / "index.js", "console.log('hi');\n")

    a = project("select-project-alpha", "# Alpha 项目\n\n这是用于文字拖选验证的第一段正文。\n", alpha_extra)
    b = project("select-project-beta", "# Beta 项目\n\n这是用于文字拖选验证的第二段正文。\n", beta_extra)
    return a, b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--run", required=True, help="要执行的命令（在测试台环境下运行）")
    ap.add_argument("--cwd", default="repo", choices=["repo", "root"])
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--python", default=None)
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    python = args.python or str(repo / ".venv" / "Scripts" / "python.exe")
    root = Path(tempfile.mkdtemp(prefix="tl-fixes-")).resolve()
    server = None
    try:
        shutil.copytree(repo / "app", root / "app",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(repo / "run.py", root / "run.py")
        shutil.copytree(repo / "tools", root / "tools",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        log = (root / "server.log").open("wb")
        server = subprocess.Popen(
            [python, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=root, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        health = None
        for _ in range(200):
            try:
                st, health = req(base, "GET", "/api/health")
            except Exception:
                health = None
            if health and health.get("ok"):
                break
            if server.poll() is not None:
                raise RuntimeError((root / "server.log").read_text(errors="replace"))
            time.sleep(0.1)
        if not health or not health.get("ok"):
            raise RuntimeError("服务启动超时：" + (root / "server.log").read_text(errors="replace"))
        if Path(health["data_path"]).resolve() != root / "data" / "projects.db":
            raise RuntimeError(f"数据目录不匹配：{health['data_path']}")

        a, b = make_samples(root)
        projects = []
        for d in (a, b):
            st, p = req(base, "POST", "/api/projects", {"path": str(d), "category": "测试"})
            if st not in (200, 201):
                raise RuntimeError(f"创建样例失败 {st}: {p}")
            projects.append({"id": p["id"], "name": p["name"]})

        state = {"root": str(root), "base": base, "projects": projects}
        (root / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2),
                                        encoding="utf-8")
        print(f"[harness] root={root}\n[harness] base={base}\n[harness] projects={projects}",
              flush=True)

        env = dict(os.environ)
        env["TL_STATE"] = str(root / "state.json")
        env["TL_BASE"] = base
        env["TL_ROOT"] = str(root)
        env["NODE_PATH"] = "D:/AICache/npm/_npx/31e32ef8478fbf80/node_modules"
        proc = subprocess.run(args.run, shell=True,
                              cwd=str(root if args.cwd == "root" else repo), env=env)
        print(f"[harness] 命令退出码：{proc.returncode}", flush=True)
        return proc.returncode
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
            print(f"[harness] 已清理 {root}", flush=True)
        else:
            print(f"[harness] 保留 {root}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
