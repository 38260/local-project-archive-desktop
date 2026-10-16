"""在 isolated_instance 测试台中验证本人筛选、fork 和全局去重。"""
from datetime import date
import json
from pathlib import Path
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
    assert all(len(c["projects"]) == 2 for c in detail["projects"][0]["commits"])
    assert req(base, "GET", "/api/day-commits?date=2026-99-99")[0] == 422
    req(base, "PUT", "/api/settings", {"git.author_emails": ["absent@example.com"]})
    assert req(base, "GET", "/api/heatmap")[1]["total"] == 0
    assert req(base, "GET", f"/api/projects/{pid}/commits?authors=mine")[1]["total_count"] == 0
    req(base, "PUT", "/api/settings", {"git.author_emails": []})
    assert req(base, "GET", f"/api/projects/{pid}/commits?authors=mine")[1]["identity_required"]
    print("[PASS] 隔离 API：邮箱校验、筛选/计数、旧接口、纯 fork、重复副本与当日去重、空身份")


if __name__ == "__main__":
    main()
