"""本周拾光：近 7 个本地日历日的本人提交聚合。

口径：
  - 只统计调用方传入的（已按本人邮箱过滤的）提交；
  - 同一完整哈希跨项目/复制仓库只计一次，按稳定项目 ID 顺序首次归属；
  - 归属决定每日堆叠与项目分布，关联项目列表仍保留全部副本，不丢信息；
  - 提交时间统一转成本地时区后再按日历日分桶。
"""
from datetime import date, datetime, timedelta

WEEK_DAYS = 7
_WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def parse_local_date(iso):
    """带时区的 ISO 时间 → 本地日历日；缺失、无时区或非法值返回 None。"""
    if not isinstance(iso, str) or not iso.strip():
        return None
    try:
        dt = datetime.fromisoformat(iso.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone().date()


def week_window(today: date | None = None, days: int = WEEK_DAYS):
    """返回 (start, end, 从旧到新的日期列表)。窗口包含今天及之前 days-1 天。"""
    end = today or date.today()
    start = end - timedelta(days=max(1, days) - 1)
    return start, end, [start + timedelta(days=i) for i in range(max(1, days))]


def _commit_ts(iso):
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def aggregate(results, start: date, end: date) -> dict:
    """把各项目提交结果聚合为 7 天面板数据。

    results 顺序不作要求：内部按项目 ID 升序决定首次归属，保证同一批数据
    在列表排序或重新加载后仍由同一项目持有提交。
    """
    ordered = sorted(results or [],
                     key=lambda r: (r.get("project") or {}).get("id") or 0)
    names: dict[int, str] = {}
    assoc: dict[str, list[dict]] = {}
    entries: dict[str, dict] = {}
    project_counts: dict[int, int] = {}
    day_counts: dict[str, dict[int, int]] = {}
    seen: set[str] = set()

    for res in ordered:
        project = res.get("project") or {}
        pid = project.get("id")
        if not isinstance(pid, int) or isinstance(pid, bool):
            continue
        names[pid] = project.get("name") or ""
        for commit in res.get("commits") or []:
            commit_hash = commit.get("hash")
            if not commit_hash:
                continue
            day = parse_local_date(commit.get("date"))
            if day is None or day < start or day > end:
                continue
            bucket = assoc.setdefault(commit_hash, [])
            if all(p["id"] != pid for p in bucket):
                bucket.append({"id": pid, "name": names[pid]})
            if commit_hash in seen:
                continue
            seen.add(commit_hash)
            project_counts[pid] = project_counts.get(pid, 0) + 1
            key = day.isoformat()
            day_counts.setdefault(key, {})
            day_counts[key][pid] = day_counts[key].get(pid, 0) + 1
            entries[commit_hash] = {
                "hash": commit_hash,
                "short": commit.get("short") or commit_hash[:8],
                "date": commit.get("date"),
                "message": commit.get("message") or "",
                "author": commit.get("author") or "",
                "project_id": pid,
                "project_name": names[pid],
                "projects": [],
            }

    for commit_hash, entry in entries.items():
        entry["projects"] = assoc.get(commit_hash, [])

    by_day: dict[str, list[dict]] = {}
    for entry in entries.values():
        day = parse_local_date(entry.get("date"))
        if day is None:
            continue
        by_day.setdefault(day.isoformat(), []).append(entry)
    for items in by_day.values():
        items.sort(key=lambda c: _commit_ts(c.get("date")), reverse=True)

    days = []
    for day in (start + timedelta(days=i) for i in range((end - start).days + 1)):
        key = day.isoformat()
        per_project = day_counts.get(key, {})
        items = [{"id": pid, "name": names.get(pid, ""), "count": count}
                 for pid, count in per_project.items()]
        items.sort(key=lambda p: (-p["count"], p["id"]))
        days.append({
            "date": key,
            "weekday": _WEEKDAY_LABELS[day.weekday()],
            "total": sum(per_project.values()),
            "projects": items,
        })

    projects = [{"id": pid, "name": names.get(pid, ""), "count": count}
                for pid, count in project_counts.items()]
    projects.sort(key=lambda p: (-p["count"], p["id"]))

    detail = []
    for day in reversed(days):
        items = by_day.get(day["date"])
        if not items:
            continue
        detail.append({
            "date": day["date"],
            "weekday": day["weekday"],
            "total": day["total"],
            "commits": items,
        })

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": days,
        "projects": projects,
        "total": len(seen),
        "project_count": len(project_counts),
        "active_days": sum(1 for d in days if d["total"] > 0),
        "commits_by_day": detail,
    }
