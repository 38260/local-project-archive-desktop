"""R1 自动刷新（后端统一入口）隔离验证：临时项目 + 隔离数据库。

运行：
  .venv/Scripts/python.exe tools/test_auto_refresh.py

全程不碰正式档案库：把 app/ 复制到 .workbuddy/tmp/auto-refresh-run/ 后再起服务，
数据目录随之落在该目录的 data/ 下（脚本启动时会断言）。结束后删除运行目录。
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
from contextlib import contextmanager

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_DIR = os.path.join(REPO, ".workbuddy", "tmp", "auto-refresh-run")
PORT = 8421
BASE = f"http://127.0.0.1:{PORT}"

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = ""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name}" + (f"  -> {detail}" if detail else ""))


def req(method: str, path: str, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, {"raw": raw}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"detail": raw}


def write(path: str, content: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def git(path: str, *args: str):
    subprocess.run(["git", "-c", "user.name=Tracelight Test",
                    "-c", "user.email=test@example.com", *args],
                   cwd=path, check=True, capture_output=True)


def make_project(name: str, with_git: bool = True) -> str:
    p = os.path.join(RUN_DIR, "samples", name)
    write(os.path.join(p, "README.md"), f"# {name}\n\n初始简介：用于自动刷新验证。\n")
    write(os.path.join(p, "package.json"),
          json.dumps({"name": name, "version": "1.0.0",
                      "dependencies": {"vue": "^3.4.0"}}, ensure_ascii=False, indent=2))
    write(os.path.join(p, "src", "nested", "a.py"), "print('a')\n")
    if with_git:
        git(p, "init", "-q")
        git(p, "add", "-A")
        git(p, "commit", "-q", "-m", "feat: init")
    return p


def _rmtree(path: str):
    """稳健删除：Windows 上 rmtree 可能被回收站钩子拦下，退回 cmd rd。"""
    if not os.path.isdir(path):
        return
    if os.getcwd().lower().startswith(os.path.abspath(path).lower()):
        os.chdir(REPO)          # 进程 cwd 在目标目录内时 Windows 不允许删除
    shutil.rmtree(path, ignore_errors=True)
    if os.path.isdir(path):
        subprocess.run(["cmd", "/c", "rd", "/s", "/q", path], capture_output=True)
    if os.path.isdir(path):
        print(f"[WARN] 临时目录未能删除：{path}")


def prepare():
    _rmtree(RUN_DIR)
    os.makedirs(RUN_DIR, exist_ok=True)
    shutil.copytree(os.path.join(REPO, "app"), os.path.join(RUN_DIR, "app"),
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(os.path.join(REPO, "run.py"), os.path.join(RUN_DIR, "run.py"))


def start_server():
    sys.path.insert(0, RUN_DIR)
    os.chdir(RUN_DIR)
    import uvicorn
    from app.main import app as fastapi_app

    cfg = uvicorn.Config(fastapi_app, host="127.0.0.1", port=PORT, log_level="error")
    server = uvicorn.Server(cfg)
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        time.sleep(0.2)
        try:
            st, _ = req("GET", "/api/health", timeout=2)
            if st == 200:
                return server
        except Exception:
            pass
    raise RuntimeError("隔离服务启动失败")


def wait_job(job_id: str, timeout: float = 90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, job = req("GET", f"/api/refresh/{job_id}")
        if st == 200 and job.get("state") == "done":
            return job
        time.sleep(0.15)
    raise AssertionError(f"刷新任务超时：{job_id}")


@contextmanager
def slow_parse(delay: float):
    """把解析拖慢，用于制造「刷新进行中」的并发窗口。"""
    from app.services import parser
    orig = parser.parse_project

    def slow(path):
        time.sleep(delay)
        return orig(path)

    parser.parse_project = slow
    try:
        yield
    finally:
        parser.parse_project = orig


def row(pid: int) -> dict:
    from app.db import get_db
    with get_db() as conn:
        r = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        return dict(r) if r else {}


def run_tests():
    from app.services import refresh

    refresh.reset_state()

    # ---------------------------------------------------------------- 准备
    path_a = make_project("demo-auto-a")
    path_b = make_project("demo-auto-b", with_git=False)
    st, proj_a = req("POST", "/api/projects", {"path": path_a})
    st2, proj_b = req("POST", "/api/projects", {"path": path_b})
    if st not in (200, 201) or st2 not in (200, 201):
        raise RuntimeError(f"录入失败：{st} {proj_a} / {st2} {proj_b}")
    pid_a, pid_b = proj_a["id"], proj_b["id"]

    # 手动标签 + 描述 + 笔记（自动刷新必须原样保留）
    req("PUT", f"/api/projects/{pid_a}",
        {"tags": ["我的标签"], "description": "手写描述，不许被自动刷新覆盖"})
    req("POST", f"/api/projects/{pid_a}/notes", {"content": "草稿内容：自动刷新不动我"})

    base = row(pid_a)
    base_tags = json.loads(base["tags"])
    base_desc = base["description"]
    base_updated = base["updated_at"]

    print("\n--- T1 进入详情：自动刷新单项目 ---")
    st, r = req("POST", "/api/refresh", {"ids": [pid_a]})
    check("请求被接受并返回 job_id", st == 200 and bool(r.get("job_id")), str(r))
    job = wait_job(r["job_id"])
    check("刷新成功", job["ok"] == 1 and job["done"] == 1, str(job.get("failed")))
    after = row(pid_a)
    check("auto_meta 已写入", bool(json.loads(after["auto_meta"]).get("stats")))
    check("自动刷新不改 updated_at", after["updated_at"] == base_updated,
          f'{after["updated_at"]} != {base_updated}')
    check("自动刷新保留手动标签", json.loads(after["tags"]) == base_tags,
          str(after["tags"]))
    check("自动刷新保留描述", after["description"] == base_desc)
    check("自动刷新保留笔记",
          len(req("GET", f"/api/projects/{pid_a}/notes")[1]["notes"]) == 1)

    print("\n--- T2 冷却 30 秒与手动跳过 ---")
    st, r = req("POST", "/api/refresh", {"ids": [pid_a]})
    check("冷却期内返回 skipped 且无 job", r.get("job_id") is None and pid_a in r.get("skipped", []),
          str(r))
    st, status = req("GET", "/api/refresh/status")
    check("冷却秒数可查", status.get("cooldown_seconds") == 30, str(status.get("cooldown_seconds")))
    st, r = req("POST", "/api/refresh", {"ids": [pid_a], "force": True})
    check("force 跳过冷却", bool(r.get("job_id")), str(r))
    wait_job(r["job_id"])

    print("\n--- T3 采集数据确实随磁盘变化 ---")
    before = json.loads(row(pid_a)["auto_meta"])
    write(os.path.join(path_a, "README.md"), "# demo-auto-a\n\n改过的简介：自动刷新应更新。\n")
    write(os.path.join(path_a, "src", "nested", "deep", "b.js"), "console.log('b')\n")
    write(os.path.join(path_a, "src", "nested", "c.js"), "console.log('c')\n")
    os.remove(os.path.join(path_a, "src", "nested", "a.py"))
    git(path_a, "add", "-A")
    git(path_a, "commit", "-q", "-m", "feat: 新增嵌套文件")
    st, r = req("POST", "/api/refresh", {"ids": [pid_a], "force": True})
    job = wait_job(r["job_id"])
    check("刷新识别 changed", pid_a in job.get("changed_ids", []), str(job.get("items")))
    after_meta = json.loads(row(pid_a)["auto_meta"])
    check("README 简介已更新",
          after_meta.get("intro") != before.get("intro"), f'{before.get("intro")} -> {after_meta.get("intro")}')
    check("嵌套文件增删反映到文件统计",
          after_meta["stats"]["file_count"] != before["stats"]["file_count"],
          f'{before["stats"]["file_count"]} -> {after_meta["stats"]["file_count"]}')
    check("新增提交被识别",
          (after_meta.get("git") or {}).get("commit_count", 0)
          > ((before.get("git") or {}).get("commit_count", 0)),
          str((after_meta.get("git") or {}).get("commit_count")))
    check("技术栈重新识别", "Node.js" in (after_meta.get("tech_tags") or []),
          str(after_meta.get("tech_tags")))

    print("\n--- T4 刷新进行中：合并重复请求 ---")
    refresh.reset_state()
    with slow_parse(1.2):
        st, first = req("POST", "/api/refresh", {"ids": [pid_a]})
        time.sleep(0.2)
        st, second = req("POST", "/api/refresh", {"ids": [pid_a]})
        check("重复请求被合并（同一 job）",
              second.get("job_id") == first.get("job_id") and pid_a in second.get("merged", []),
              f'{first.get("job_id")} / {second}')
        wait_job(first["job_id"])

    print("\n--- T5 路径丢失：保留上次有效数据 ---")
    from app.db import get_db
    meta_before_lost = row(pid_a)["auto_meta"]
    gone_path = os.path.join(RUN_DIR, "samples", "demo-auto-a-gone")
    with get_db() as conn:      # 模拟文件夹被移动/删除（不真的动磁盘，避免 Windows 句柄占用）
        conn.execute("UPDATE projects SET path=? WHERE id=?", (gone_path, pid_a))
    st, r = req("POST", "/api/refresh", {"ids": [pid_a], "force": True})
    job = wait_job(r["job_id"])
    item = job["items"][0]
    check("路径丢失标记成功", item.get("ok") and item.get("lost"), str(item))
    lost_row = row(pid_a)
    check("is_lost=1", lost_row["is_lost"] == 1, str(lost_row["is_lost"]))
    check("丢失时保留上次有效 auto_meta", lost_row["auto_meta"] == meta_before_lost)
    check("丢失不改 updated_at", lost_row["updated_at"] == base_updated)
    with get_db() as conn:      # 路径修回（等价用户把文件夹移回原位）
        conn.execute("UPDATE projects SET path=? WHERE id=?", (path_a, pid_a))
    st, r = req("POST", "/api/refresh", {"ids": [pid_a], "force": True})
    job = wait_job(r["job_id"])
    check("路径恢复后自动复活", row(pid_a)["is_lost"] == 0 and job["items"][0].get("ok"))

    print("\n--- T6 刷新期间改路径：旧结果不回填 ---")
    refresh.reset_state()
    meta_before_race = row(pid_a)["auto_meta"]
    # 目标目录必须是「存在的另一个目录」，且未被其他档案占用（path 有唯一约束）
    path_d = make_project("demo-auto-d", with_git=False)
    with slow_parse(1.5):
        st, r = req("POST", "/api/refresh", {"ids": [pid_a], "force": True})
        time.sleep(0.4)
        with get_db() as conn:
            conn.execute("UPDATE projects SET path=? WHERE id=?", (path_d, pid_a))
        job = wait_job(r["job_id"])
    item = job["items"][0]
    check("路径变更后的结果被丢弃", item.get("ok") is False and item.get("stale"), str(item))
    check("旧结果未覆盖 auto_meta", row(pid_a)["auto_meta"] == meta_before_race)
    with get_db() as conn:
        conn.execute("UPDATE projects SET path=? WHERE id=?", (path_a, pid_a))

    print("\n--- T7 刷新期间删除项目：不复活、不写库 ---")
    refresh.reset_state()
    with slow_parse(1.2):
        st, r = req("POST", "/api/refresh", {"ids": [pid_b], "force": True})
        time.sleep(0.3)
        req("DELETE", f"/api/projects/{pid_b}")
        job = wait_job(r["job_id"])
    item = job["items"][0]
    check("删除后的刷新结果被拒绝", item.get("ok") is False, str(item))
    check("项目确实已删除", req("GET", f"/api/projects/{pid_b}")[0] == 404)

    print("\n--- T8 手动刷新语义：合并标签 + 更新 updated_at ---")
    refresh.reset_state()
    before_manual = row(pid_a)
    res = refresh.refresh_now(pid_a, mode="manual")
    after_manual = row(pid_a)
    check("手动刷新成功", res.get("ok"), str(res))
    check("手动刷新更新 updated_at", after_manual["updated_at"] != before_manual["updated_at"])
    check("手动刷新合并自动标签",
          "Node.js" in json.loads(after_manual["tags"]),
          str(after_manual["tags"]))
    check("手动刷新保留手填标签", "我的标签" in json.loads(after_manual["tags"]))

    print("\n--- T9 空请求与未知项目 ---")
    st, r = req("POST", "/api/refresh", {"ids": []})
    check("空 ids 返回 noop", st == 200 and r.get("state") == "noop", str(r))
    st, r = req("POST", "/api/refresh", {"ids": [999999], "force": True})
    check("未知项目进 missing", st == 200 and 999999 in r.get("missing", []), str(r))
    st, _ = req("GET", "/api/refresh/not-a-job")
    check("未知任务返回 404", st == 404)

    print("\n--- T10 批量刷新（首页场景）---")
    refresh.reset_state()
    path_e = make_project("demo-auto-e", with_git=False)
    st, proj_e = req("POST", "/api/projects", {"path": path_e})
    pid_e = proj_e["id"]
    st, r = req("POST", "/api/refresh", {"ids": [pid_a, pid_e], "force": True})
    job = wait_job(r["job_id"])
    check("批量任务覆盖全部项目", job["total"] == 2 and job["done"] == 2
          and job["ok"] == 2, str(job.get("failed")))
    check("批量任务返回 changed_ids 字段", isinstance(job.get("changed_ids"), list),
          str(job.get("changed_ids")))


def main():
    prepare()
    server = start_server()
    st, health = req("GET", "/api/health")
    assert os.path.normcase(health["data_path"]).startswith(
        os.path.normcase(os.path.join(RUN_DIR, "data"))), f"数据目录未隔离！{health['data_path']}"
    print(f"隔离服务：{BASE}")
    print(f"数据目录：{health['data_path']}（已确认隔离）")
    try:
        run_tests()
    finally:
        server.should_exit = True
        time.sleep(0.8)
        _rmtree(RUN_DIR)
    print(f"\n===== 结果：PASS {PASS} / FAIL {FAIL} =====")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
