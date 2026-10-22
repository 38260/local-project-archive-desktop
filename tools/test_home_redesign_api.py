"""首页改版 API 回归（isolated_instance 测试台内运行）。

用法（由 tools/isolated_instance.py 的 --run 调用）：
  python tools/test_home_redesign_api.py %TL_STATE%
"""
import json
import os
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from isolated_instance import req


def git(cwd, *args, **env):
    subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True,
        encoding="utf-8",
        env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
             "GIT_CONFIG_NOSYSTEM": "1", **env},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def commit_at(repo, message, email, local_dt):
    stamp = local_dt.astimezone().isoformat()
    git(repo, "commit", "--allow-empty", "-m", message,
        GIT_AUTHOR_NAME="Me", GIT_AUTHOR_EMAIL=email,
        GIT_COMMITTER_NAME="Me", GIT_COMMITTER_EMAIL=email,
        GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)


def main():
    state = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    root = Path(state["root"]).resolve()
    base = state["base"]
    assert root.name.startswith("tl-fixes-"), root
    health = req(base, "GET", "/api/health")[1]
    assert Path(health["data_path"]).resolve() == root / "data" / "projects.db"

    status, listing = req(base, "GET", "/api/projects")
    assert status == 200 and listing["projects"], listing
    project = listing["projects"][0]
    pid = project["id"]
    assert project["last_opened_at"] == "", project

    # 读取详情本身不写访问记录
    status, detail = req(base, "GET", f"/api/projects/{pid}")
    assert status == 200 and detail["last_opened_at"] == ""
    before_updated = detail["updated_at"]
    before_modified = detail["fs_modified"]
    req(base, "GET", "/api/projects")
    assert req(base, "GET", f"/api/projects/{pid}")[1]["last_opened_at"] == ""

    status, visited = req(base, "POST", f"/api/projects/{pid}/visit")
    assert status == 200 and visited["ok"] is True, visited
    recorded = visited["last_opened_at"]
    parsed = datetime.fromisoformat(recorded)
    assert parsed.tzinfo is not None and parsed.utcoffset() is not None, recorded

    detail = req(base, "GET", f"/api/projects/{pid}")[1]
    assert detail["last_opened_at"] == recorded
    assert detail["updated_at"] == before_updated, "访问记录不能修改 updated_at"
    assert detail["fs_modified"] == before_modified, "访问记录不能修改磁盘修改时间"
    row = next(p for p in req(base, "GET", "/api/projects")[1]["projects"]
               if p["id"] == pid)
    assert row["last_opened_at"] == recorded
    assert req(base, "POST", "/api/projects/999999/visit")[0] == 404

    exported = req(base, "GET", "/api/export")[1]
    exported_item = next(p for p in exported["projects"] if p["id"] == pid)
    assert exported_item["last_opened_at"] == recorded

    # 旧备份缺字段：导入后为空，不伪造历史访问
    def import_one(name, extra=None):
        path = root / name
        path.mkdir(exist_ok=True)
        item = {"path": str(path), "name": name}
        if extra:
            item.update(extra)
        status, result = req(base, "POST", "/api/import", {"projects": [item]})
        assert status == 200 and result["imported"] == 1, result
        rows = req(base, "GET", "/api/projects")[1]["projects"]
        return next(p for p in rows if p["path"] == str(path))

    old = import_one("home-import-old")
    assert old["last_opened_at"] == ""
    naive = import_one("home-import-naive",
                       {"last_opened_at": "2026-10-20T08:15:00"})
    assert naive["last_opened_at"] == "", "无时区时间不应被当作有效访问记录"
    broken = import_one("home-import-broken",
                        {"last_opened_at": "not-a-date"})
    assert broken["last_opened_at"] == ""
    valid = import_one("home-import-valid",
                       {"last_opened_at": "2026-10-20T08:15:00Z"})
    parsed_valid = datetime.fromisoformat(valid["last_opened_at"])
    assert parsed_valid.tzinfo is not None
    assert parsed_valid.timestamp() == datetime.fromisoformat(
        "2026-10-20T08:15:00+00:00").timestamp()

    # 连续记录只更新时间，旧值可被覆盖（时间单调不减由真实时钟保证）
    second = req(base, "POST", f"/api/projects/{pid}/visit")[1]["last_opened_at"]
    assert datetime.fromisoformat(second) >= datetime.fromisoformat(recorded)
    print("[PASS] F1 访问时间：迁移/读取不写/成功记录/404/元数据不变/导出与旧备份导入兼容")

    # ---- F4 本周拾光：真实临时 Git 仓库，跨仓库去重、唯一归属、本地日期 ----
    today = date.today()
    yesterday = today - timedelta(days=1)
    repo_a = root / "week-a"
    repo_a.mkdir()
    git(repo_a, "init", "-b", "main")
    commit_at(repo_a, "feat: a today 1", "me@example.com",
              datetime.combine(today, time(10, 0)))
    commit_at(repo_a, "feat: a today 2", "me@example.com",
              datetime.combine(today, time(11, 0)))
    repo_b = root / "week-b"
    git(root, "clone", "--no-hardlinks", str(repo_a), str(repo_b))

    repo_c = root / "week-c"
    repo_c.mkdir()
    git(repo_c, "init", "-b", "main")
    commit_at(repo_c, "feat: c today", "me@example.com",
              datetime.combine(today, time(9, 0)))
    # 用 UTC 表示本地昨晚 23:30 的同一时刻，验证按本地日期而不是 UTC 前缀分桶
    boundary = datetime.combine(yesterday, time(23, 30)).astimezone(timezone.utc)
    commit_at(repo_c, "feat: c boundary", "me@example.com", boundary)
    commit_at(repo_c, "feat: c other", "other@example.com",
              datetime.combine(today, time(12, 0)))

    week_ids = {}
    for path in (repo_a, repo_b, repo_c):
        status, item = req(base, "POST", "/api/projects", {"path": str(path)})
        assert status == 201, item
        week_ids[path.name] = item["id"]

    assert req(base, "PUT", "/api/settings",
               {"git.author_emails": ["me@example.com"]})[0] == 200
    status, week = req(base, "GET", "/api/weekly")
    assert status == 200, week
    assert week["start"] == (today - timedelta(days=6)).isoformat()
    assert week["end"] == today.isoformat()
    assert len(week["days"]) == 7
    assert week["total"] == 4, week
    assert week["project_count"] == 2, week
    assert week["active_days"] == 2, week
    assert week["repos"] == 3
    assert week["failed_repos"] == 0
    assert week["identity_required"] is False
    assert sum(d["total"] for d in week["days"]) == week["total"]
    assert sum(p["count"] for p in week["projects"]) == week["total"]
    assert sum(sum(p["count"] for p in d["projects"]) for d in week["days"]) == week["total"]
    day_today = next(d for d in week["days"] if d["date"] == today.isoformat())
    day_yesterday = next(d for d in week["days"] if d["date"] == yesterday.isoformat())
    assert day_today["total"] == 3, day_today
    assert day_yesterday["total"] == 1, day_yesterday
    # 归属项目 ID 较小者：clone 的提交不重复计入，但明细保留关联副本
    counts = {p["id"]: p["count"] for p in week["projects"]}
    assert counts[week_ids["week-a"]] == 2, counts
    assert counts[week_ids["week-c"]] == 2, counts
    assert week_ids["week-b"] not in counts
    a_commit = next(c for d in week["commits_by_day"] for c in d["commits"]
                    if c["message"] == "feat: a today 1")
    assert a_commit["project_id"] == week_ids["week-a"]
    assert {p["id"] for p in a_commit["projects"]} == {
        week_ids["week-a"], week_ids["week-b"]}
    assert sum(d["total"] for d in week["commits_by_day"]) == week["total"]

    status, day_detail = req(base, "GET", f"/api/day-commits?date={today}&tz=local")
    assert status == 200 and day_detail["total"] == day_today["total"] == 3
    # 当日明细仍保留全部关联副本：A、B 与 C 三个项目，但去重后仅 3 条提交
    assert day_detail["project_count"] == 3
    assert req(base, "GET", "/api/heatmap?weeks=1")[0] == 422, "旧接口最小值保持 8"
    assert req(base, "GET", "/api/heatmap")[1]["total"] == 4

    # 空窗口、未匹配邮箱、未配置邮箱分别返回真实状态
    req(base, "PUT", "/api/settings", {"git.author_emails": ["absent@example.com"]})
    empty = req(base, "GET", "/api/weekly")[1]
    assert empty["total"] == 0 and empty["project_count"] == 0
    assert empty["active_days"] == 0 and empty["commits_by_day"] == []
    assert sum(d["total"] for d in empty["days"]) == 0
    assert empty["identity_required"] is False
    req(base, "PUT", "/api/settings", {"git.author_emails": []})
    unset = req(base, "GET", "/api/weekly")[1]
    assert unset["identity_required"] is True and unset["total"] == 0
    assert len(unset["days"]) == 7
    req(base, "PUT", "/api/settings", {"git.author_emails": ["me@example.com"]})
    print("[PASS] F4 本周拾光：近 7 天、跨仓库去重/唯一归属、本地日期边界、守恒与空/未配置状态")


if __name__ == "__main__":
    main()
