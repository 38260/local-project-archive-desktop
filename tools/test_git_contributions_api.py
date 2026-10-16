"""在 isolated_instance 测试台中验证本人筛选、fork 和全局去重。"""
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

from isolated_instance import req
from test_git_contributions import git, make_repo


def main():
    state = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    root, base = Path(state["root"]).resolve(), state["base"]
    assert root.name.startswith("tl-fixes-")
    assert Path(req(base, "GET", "/api/health")[1]["data_path"]).resolve() == root / "data/projects.db"
    repo = make_repo(root)
    clone = root / "fork"
    git(root, "clone", "--no-hardlinks", str(repo), str(clone))
    projects = []
    for path in (repo, clone):
        status, project = req(base, "POST", "/api/projects", {"path": str(path)})
        assert status == 201
        projects.append(project)
    # 只继承上游历史、没有本人提交的 fork。
    upstream = root / "upstream-only"
    git(root, "clone", "--no-hardlinks", str(repo), str(upstream))
    first = git(repo, "rev-list", "--max-parents=0", "HEAD")
    git(upstream, "checkout", "--detach", first)
    status, pure = req(base, "POST", "/api/projects", {"path": str(upstream)})
    assert status == 201
    pid = projects[0]["id"]
    today = date.today().isoformat()
    initial = req(base, "GET", "/api/heatmap")[1]
    assert initial["identity_required"] and initial["total"] == 0
    assert req(base, "PUT", "/api/settings", {"git.author_emails": "bad"})[0] == 400
    assert req(base, "PUT", "/api/settings", {"git.author_emails": ["ME+WORK@example.com", "old@example.com"]})[0] == 200
    for suffix, field in (("commits?limit=1&", "total_count"), ("heatmap?", "total"), ("commit-stats?", "scanned")):
        status, result = req(base, "GET", f"/api/projects/{pid}/{suffix}authors=mine")
        assert status == 200 and result[field] == 2, result
        assert req(base, "GET", f"/api/projects/{pid}/{suffix}authors=all")[1][field] == 5
    assert req(base, "GET", f"/api/projects/{pid}/commits")[1]["total_count"] == 5
    assert req(base, "GET", f"/api/projects/{pid}/commits?authors=invalid")[0] == 422
    heat = req(base, "GET", "/api/heatmap")[1]
    detail = req(base, "GET", f"/api/day-commits?date={today}")[1]
    assert heat["total"] == detail["total"] == 2
    assert heat["days"][today]["count"] == 2
    assert len(detail["projects"]) == 1
    assert detail["project_count"] == 2
    assert all(len(c["projects"]) == 2 for c in detail["projects"][0]["commits"])
    assert req(base, "GET", f"/api/projects/{pure['id']}/commits?authors=mine")[1]["total_count"] == 0
    assert req(base, "GET", "/api/day-commits?date=2026-99-99")[0] == 422
    req(base, "PUT", "/api/settings", {"git.author_emails": ["absent@example.com"]})
    assert req(base, "GET", "/api/heatmap")[1]["total"] == 0
    assert req(base, "GET", f"/api/projects/{pid}/commits?authors=mine")[1]["total_count"] == 0
    req(base, "PUT", "/api/settings", {"git.author_emails": []})
    assert req(base, "GET", f"/api/projects/{pid}/commits?authors=mine")[1]["identity_required"]
    # fast-import 在临时仓库一次构造 205 条真实提交，验证首页明细没有旧的 200 条上限。
    bulk = root / "bulk"
    bulk.mkdir()
    git(bulk, "init", "-b", "main")
    stamp = int(datetime.fromisoformat(f"{today}T12:00:00").replace(tzinfo=timezone.utc).timestamp())
    stream = "".join(f"commit refs/heads/main\ncommitter Bulk <bulk@example.com> {stamp} +0000\n"
                     f"data {len(f'feat: bulk {i}')}\nfeat: bulk {i}\n\n" for i in range(205))
    imported = subprocess.run(["git", "fast-import", "--quiet"], cwd=bulk,
                              input=stream.encode(), capture_output=True,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert imported.returncode == 0, imported.stderr.decode(errors="replace")
    assert req(base, "POST", "/api/projects", {"path": str(bulk)})[0] == 201
    req(base, "PUT", "/api/settings", {"git.author_emails": ["bulk@example.com"]})
    heat = req(base, "GET", "/api/heatmap")[1]
    detail = req(base, "GET", f"/api/day-commits?date={today}")[1]
    assert heat["total"] == detail["total"] == 205
    assert len(detail["projects"][0]["commits"]) == 205
    req(base, "PUT", "/api/settings", {"git.author_emails": []})
    print("[PASS] 隔离 API：邮箱校验、筛选/计数、旧接口、纯 fork、重复副本与当日去重、空身份、单日 205 条")


if __name__ == "__main__":
    main()
