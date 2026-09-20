"""启动运行记录：捕获运行的进程管理、输出采集与历史落库。

设计要点（与「新终端窗口运行」的区别）：
  - 新终端窗口（launch 路由的 console 模式）由 Windows 新控制台承载，
    其 stdout 属于那个控制台，父进程拿不到，因此无法记录输出与退出码；
  - 捕获运行（本模块）改为后台无窗口执行 + 管道读取，
    因而能采集 stdout/stderr、退出码与耗时，供「上次为什么没起来」回溯。

安全边界：仅执行用户在前端确认过的命令；命令合法性由路由层校验（非空/无换行/长度），
工作目录由路由层限制在项目目录内；本模块不做任何原项目文件的写入。
"""
from __future__ import annotations

import locale
import logging
import os
import subprocess
import threading
import time
from datetime import datetime

from app.config import (RUN_HISTORY_MAX_PER_PROJECT, RUN_OUTPUT_LINE_MAX,
                        RUN_OUTPUT_MAX_LINES)
from app.db import get_db

logger = logging.getLogger(__name__)

# 运行状态取值（与前端展示一一对应）
STATUS_RUNNING = "running"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_STOPPED = "stopped"
STATUS_ERROR = "error"

_READ_CHUNK = 4096          # 每次从管道读取的字节数
_FORCE_LINE_BYTES = 16384   # 长时间无换行时的强制切行阈值（防单行无限增长）
_STOP_WAIT = 3.0            # 停止时等待进程退出的秒数


def _iso(ts: float) -> str:
    """时间戳 → 带时区的 ISO 字符串（与项目其它时间字段口径一致）。"""
    return datetime.fromtimestamp(ts).astimezone().isoformat()


class _Run:
    """单次运行的内存态（输出实时累积，结束后落库）。"""

    def __init__(self, run_id: int, project_id: int, name: str, command: str,
                 cwd: str, proc: subprocess.Popen):
        self.id = run_id
        self.project_id = project_id
        self.name = name
        self.command = command
        self.cwd = cwd
        self.proc = proc
        self.lines: list[str] = []
        self.lock = threading.Lock()
        self.status = STATUS_RUNNING
        self.exit_code: int | None = None
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.truncated = False
        self.stopped = False        # 用户主动停止标记（区别于异常退出）

    def append(self, line: str) -> None:
        """追加一行输出，超过上限时丢弃最早的行并标记截断。"""
        if len(line) > RUN_OUTPUT_LINE_MAX:
            line = line[:RUN_OUTPUT_LINE_MAX] + " …（本行超长已截断）"
        with self.lock:
            self.lines.append(line)
            if len(self.lines) > RUN_OUTPUT_MAX_LINES:
                overflow = len(self.lines) - RUN_OUTPUT_MAX_LINES
                del self.lines[:overflow]
                self.truncated = True

    def snapshot(self) -> list[str]:
        with self.lock:
            return list(self.lines)


# run_id -> _Run（仅保存运行中的实例；结束后落库并从内存移除）
_ACTIVE: dict[int, _Run] = {}
_ACTIVE_LOCK = threading.Lock()


_FALLBACK_ENCODING: str | None = None


def _fallback_encoding() -> str:
    """非 UTF-8 输出时使用的本地代码页（中文 Windows 为 cp936）。

    注意不能用 locale.getpreferredencoding() 兜底：Python 处于 UTF-8 模式
    （PYTHONUTF8=1 / UTF-8 locale）时它同样返回 utf-8，等于又按 UTF-8 解一次，
    中文会整段变成替换字符。这种情况直接问系统代码页（OEM/ANSI）。
    """
    global _FALLBACK_ENCODING
    if _FALLBACK_ENCODING is None:
        enc = (locale.getpreferredencoding(False) or "")
        normalized = enc.lower().replace("-", "").replace("_", "")
        if normalized and normalized != "utf8":
            _FALLBACK_ENCODING = enc
        elif os.name == "nt":
            try:
                import ctypes
                cp = ctypes.windll.kernel32.GetOEMCP() \
                    or ctypes.windll.kernel32.GetACP()
                _FALLBACK_ENCODING = f"cp{cp}" if cp else "utf-8"
            except Exception:
                _FALLBACK_ENCODING = "utf-8"
        else:
            _FALLBACK_ENCODING = "utf-8"
    return _FALLBACK_ENCODING


def _decode(raw: bytes) -> str:
    """解码一行输出。

    Windows 控制台程序多按本地代码页（中文系统为 GBK）输出，
    而 Node 等工具输出 UTF-8：先按 UTF-8 严格解码，失败再回退本地代码页，
    两种来源都能正确显示。
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode(_fallback_encoding(), errors="replace")
    return text.rstrip("\r")      # 去掉 Windows 行尾的 CR，按 \n 切行后不该留它


def _reader(run: _Run) -> None:
    """后台读取管道输出，按行切分后累积（进程结束或管道关闭时退出）。"""
    stream = run.proc.stdout
    if stream is None:
        return
    buf = b""
    try:
        while True:
            chunk = stream.read(_READ_CHUNK)
            if not chunk:
                break
            buf += chunk
            while True:
                idx = buf.find(b"\n")
                if idx < 0:
                    # 长时间无换行（进度条/二进制输出）：超过阈值就强制落一行
                    if len(buf) >= _FORCE_LINE_BYTES:
                        run.append(_decode(buf))
                        buf = b""
                    break
                run.append(_decode(buf[:idx]))
                buf = buf[idx + 1:]
        if buf:
            run.append(_decode(buf))
    except (OSError, ValueError) as exc:
        logger.debug("读取运行输出失败（run=%s）：%s", run.id, exc)
    finally:
        try:
            stream.close()
        except OSError:
            pass


def _finish(run: _Run, exit_code: int | None, status: str) -> None:
    """落库一次运行的最终状态。"""
    finished = time.time()
    run.exit_code = exit_code
    run.status = status
    run.finished_at = finished
    try:
        with get_db() as conn:
            conn.execute(
                "UPDATE runs SET status=?, exit_code=?, output=?, output_truncated=?, "
                "finished_at=? WHERE id=?",
                (status, exit_code, "\n".join(run.snapshot()),
                 1 if run.truncated else 0, _iso(finished), run.id))
    except Exception as exc:  # 落库失败不影响进程本身，仅记录
        logger.warning("运行记录落库失败（run=%s）：%s", run.id, exc)
    with _ACTIVE_LOCK:
        _ACTIVE.pop(run.id, None)


def _waiter(run: _Run) -> None:
    """等待进程退出 → 判定状态 → 落库（判定以进程退出为权威时机）。"""
    try:
        code = run.proc.wait()
    except Exception as exc:
        logger.debug("等待进程退出失败（run=%s）：%s", run.id, exc)
        _finish(run, None, STATUS_ERROR)
        return
    if run.stopped:
        status = STATUS_STOPPED
    elif code == 0:
        status = STATUS_SUCCEEDED
    else:
        status = STATUS_FAILED
    # 读线程可能在进程退出后还要把管道残留读完，稍等片刻让输出完整
    deadline = time.time() + 1.5
    while time.time() < deadline and run.proc.stdout is not None \
            and not run.proc.stdout.closed:
        time.sleep(0.05)
    _finish(run, code, status)


def _prune(conn, project_id: int) -> None:
    """每个项目只保留最近 N 条运行记录，避免历史无限增长。

    仍在运行的记录（内存态里还活着）不参与裁剪：删掉它会让进程结束时的
    状态更新落空（UPDATE 无匹配行），前端也会突然读不到这条记录。
    """
    with _ACTIVE_LOCK:
        active_ids = {rid for rid, r in _ACTIVE.items() if r.project_id == project_id}
    ordered = [r["id"] for r in conn.execute(
        "SELECT id FROM runs WHERE project_id=? ORDER BY id DESC",
        (project_id,)).fetchall()]
    keep = set(active_ids)
    for rid in ordered:                       # 运行中的先占额度，其余按新到旧保留
        if rid not in keep and len(keep) < RUN_HISTORY_MAX_PER_PROJECT:
            keep.add(rid)
    stale = [rid for rid in ordered if rid not in keep]
    if stale:
        conn.executemany("DELETE FROM runs WHERE id=?", [(i,) for i in stale])


def start_run(project_id: int, name: str, command: str, cwd: str) -> dict:
    """在后台无窗口执行命令并开始采集输出，返回运行记录（含 run_id）。

    命令经 cmd /c 执行（等价于用户在命令行里敲这条命令）；
    cwd 由调用方保证在项目目录内。
    """
    now = datetime.now().astimezone().isoformat()
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO runs (project_id, name, command, cwd, status, started_at) "
            "VALUES (?,?,?,?,?,?)",
            (project_id, name, command, cwd, STATUS_RUNNING, now))
        run_id = cur.lastrowid
        _prune(conn, project_id)

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(  # noqa: S603 本地工具，用户确认后执行
            f"cmd /c {command}", cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, creationflags=flags)
    except OSError as exc:
        with get_db() as conn:
            conn.execute(
                "UPDATE runs SET status=?, finished_at=?, output=? WHERE id=?",
                (STATUS_ERROR, now, f"启动失败：{exc}", run_id))
        return {"run_id": run_id, "status": STATUS_ERROR, "error": f"启动失败：{exc}"}

    run = _Run(run_id, project_id, name, command, cwd, proc)
    with _ACTIVE_LOCK:
        _ACTIVE[run_id] = run
    threading.Thread(target=_reader, args=(run,), daemon=True).start()
    threading.Thread(target=_waiter, args=(run,), daemon=True).start()
    logger.info("捕获运行已启动（project=%s run=%s pid=%s）：%s",
                project_id, run_id, proc.pid, command)
    return {"run_id": run_id, "status": STATUS_RUNNING, "pid": proc.pid}


def stop_run(project_id: int, run_id: int) -> bool:
    """停止运行中的进程（含子进程树）。返回是否确实发出了停止指令。"""
    with _ACTIVE_LOCK:
        run = _ACTIVE.get(run_id)
    if run is None or run.project_id != project_id:
        return False
    run.stopped = True
    pid = run.proc.pid
    try:
        if os.name == "nt":
            # cmd /c 会派生子进程（node/python 等），只杀 cmd 会留下孤儿占端口，
            # 因此用 taskkill /T 结束整棵树
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                           capture_output=True, timeout=_STOP_WAIT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            run.proc.terminate()
    except Exception as exc:
        logger.warning("停止运行失败（run=%s）：%s", run_id, exc)
        try:
            run.proc.terminate()
        except Exception:
            return False
    return True


def get_run(project_id: int, run_id: int, offset: int = 0) -> dict | None:
    """读取一次运行的状态与输出（offset 之前的行不再重复返回，供前端增量轮询）。"""
    with _ACTIVE_LOCK:
        run = _ACTIVE.get(run_id)
    if run is not None and run.project_id == project_id:
        lines = run.snapshot()
        info = {
            "id": run.id, "name": run.name, "command": run.command, "cwd": run.cwd,
            "status": run.status, "exit_code": run.exit_code,
            "started_at": _iso(run.started_at),
            "finished_at": _iso(run.finished_at) if run.finished_at else None,
            "elapsed": round((run.finished_at or time.time()) - run.started_at, 1),
            "output_truncated": run.truncated,
            "running": run.status == STATUS_RUNNING,
        }
    else:
        with get_db() as conn:
            r = conn.execute("SELECT * FROM runs WHERE id=? AND project_id=?",
                             (run_id, project_id)).fetchone()
        if r is None:
            return None
        lines = (r["output"] or "").split("\n") if r["output"] else []
        started = _parse_ts(r["started_at"])
        finished = _parse_ts(r["finished_at"])
        info = {
            "id": r["id"], "name": r["name"], "command": r["command"], "cwd": r["cwd"],
            "status": r["status"], "exit_code": r["exit_code"],
            "started_at": r["started_at"], "finished_at": r["finished_at"],
            "elapsed": round((finished - started), 1) if (started and finished) else None,
            "output_truncated": bool(r["output_truncated"]),
            "running": r["status"] == STATUS_RUNNING,
        }
    offset = max(0, min(int(offset or 0), len(lines)))
    return {"run": info, "lines": lines[offset:], "offset": len(lines)}


def _parse_ts(value) -> float | None:
    """解析落库的 ISO 时间串（带时区），失败返回 None。"""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except (TypeError, ValueError):
        return None


def list_runs(project_id: int, limit: int = 10) -> list[dict]:
    """运行历史列表（不含输出正文，只给状态摘要，避免列表接口过重）。"""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, command, cwd, status, exit_code, output_truncated, "
            "started_at, finished_at FROM runs WHERE project_id=? "
            "ORDER BY id DESC LIMIT ?",
            (project_id, max(1, min(int(limit or 10), 50)))).fetchall()
    items = []
    for r in rows:
        started = _parse_ts(r["started_at"])
        finished = _parse_ts(r["finished_at"])
        items.append({
            "id": r["id"], "name": r["name"], "command": r["command"], "cwd": r["cwd"],
            "status": r["status"], "exit_code": r["exit_code"],
            "started_at": r["started_at"], "finished_at": r["finished_at"],
            "elapsed": round(finished - started, 1) if (started and finished) else None,
            "output_truncated": bool(r["output_truncated"]),
            "running": r["status"] == STATUS_RUNNING,
        })
    return items


def delete_run(project_id: int, run_id: int) -> bool:
    """删除一条运行记录（运行中的不允许删除，先停止）。"""
    with _ACTIVE_LOCK:
        if run_id in _ACTIVE:
            return False
    with get_db() as conn:
        cur = conn.execute("DELETE FROM runs WHERE id=? AND project_id=?",
                           (run_id, project_id))
        return cur.rowcount > 0


def clear_runs(project_id: int) -> int:
    """清空某项目的运行历史（保留运行中的记录，避免丢失停止入口）。"""
    with _ACTIVE_LOCK:
        active = [rid for rid, r in _ACTIVE.items() if r.project_id == project_id]
    with get_db() as conn:
        if active:
            marks = ",".join("?" * len(active))
            cur = conn.execute(
                f"DELETE FROM runs WHERE project_id=? AND id NOT IN ({marks})",
                (project_id, *active))
        else:
            cur = conn.execute("DELETE FROM runs WHERE project_id=?", (project_id,))
        return cur.rowcount


def shutdown() -> None:
    """应用退出时终止仍在运行的捕获进程。

    这些进程的输出管道随本进程关闭而失效，留下它们会变成看不见的孤儿进程
    （占用端口、无法停止），因此在退出时统一收尾。
    """
    with _ACTIVE_LOCK:
        runs = list(_ACTIVE.values())
    if not runs:
        return
    for run in runs:
        run.stopped = True
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(run.proc.pid)],
                               capture_output=True, timeout=_STOP_WAIT,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                run.proc.terminate()
        except Exception as exc:
            logger.debug("退出时终止运行失败（run=%s）：%s", run.id, exc)
    deadline = time.time() + _STOP_WAIT
    for run in runs:
        try:
            run.proc.wait(timeout=max(0.1, deadline - time.time()))
        except Exception:
            pass
        _finish(run, run.proc.returncode, STATUS_STOPPED)
    logger.info("已收尾 %s 个运行中的捕获进程", len(runs))
