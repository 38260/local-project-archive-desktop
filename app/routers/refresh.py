"""自动刷新 API：发起后台刷新任务、查询进度。

前端约定：
  - POST /api/refresh 立即返回（不阻塞渲染），拿 job_id 后轮询 GET /api/refresh/{job_id}；
  - state=done 时看 items[].ok / changed，决定是否重新拉取详情或列表；
  - job_id 为 null 且 state=done 表示「全在冷却中」，静默即可。
"""
from fastapi import APIRouter, HTTPException

from app.models import RefreshRequest
from app.services import refresh

router = APIRouter(prefix="/api/refresh", tags=["refresh"])


@router.post("")
def start_refresh(body: RefreshRequest):
    """请求刷新一批项目（后台执行，立即返回任务快照）。"""
    return refresh.request(body.ids, force=body.force, source=body.source)


# 注意：/status 必须声明在 /{job_id} 之前，否则会被当成 job_id 匹配
@router.get("/status")
def refresh_status():
    """全局刷新状态（in-flight / 冷却剩余 / 最近任务），验收与排查用。"""
    return refresh.status()


@router.get("/{job_id}")
def refresh_job(job_id: str):
    """任务进度快照；任务不存在或已过期返回 404。"""
    data = refresh.job(job_id)
    if data is None:
        raise HTTPException(404, "刷新任务不存在或已过期")
    return data
