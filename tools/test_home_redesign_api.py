"""首页改版 API 回归（isolated_instance 测试台内运行）。

用法（由 tools/isolated_instance.py 的 --run 调用）：
  python tools/test_home_redesign_api.py %TL_STATE%
"""
import json
import sys
from datetime import datetime
from pathlib import Path

from isolated_instance import req


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


if __name__ == "__main__":
    main()
