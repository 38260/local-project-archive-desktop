"""Pydantic 请求模型定义。"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    """手动录入项目。"""
    path: str = Field(..., description="本地项目文件夹路径（支持 Windows / WSL UNC）")
    name: Optional[str] = None
    alias: str = ""
    category: str = ""
    status: str = "进行中"
    tags: List[str] = []


class ProjectUpdate(BaseModel):
    """更新项目档案（仅数据库字段，不触碰原项目文件）。"""
    path: Optional[str] = None
    name: Optional[str] = None
    alias: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[List[str]] = None
    description: Optional[str] = None


class ScanRequest(BaseModel):
    """批量扫描请求。"""
    root: str
    max_depth: int = Field(3, ge=1, le=8)


class ScanImportRequest(BaseModel):
    """批量导入扫描候选。"""
    paths: List[str]
    category: str = ""
    status: str = "进行中"
    tags: List[str] = []


class OpenRequest(BaseModel):
    """在系统层打开项目（资源管理器 / VSCode）。"""
    target: Literal["explorer", "vscode"]


class RenderRequest(BaseModel):
    """Markdown 渲染预览。"""
    text: str
    mode: Literal["notes", "readme"] = "notes"


class NoteCreate(BaseModel):
    """新建开发笔记。"""
    content: str = Field(..., min_length=1, description="Markdown 正文")


class NoteUpdate(BaseModel):
    """编辑开发笔记。"""
    content: str = Field(..., min_length=1, description="Markdown 正文")


# 允许空串：路由层把空串/缺省补成当天（与「留空取当天」的产品语义一致）
_ENTRY_DATE_RE = r"^(\d{4}-\d{2}-\d{2})?$"


class ChangelogCreate(BaseModel):
    """新建变更日志条目。"""
    title: str = ""
    content: str = Field(..., min_length=1, description="Markdown 正文")
    entry_date: Optional[str] = Field(None, pattern=_ENTRY_DATE_RE,
                                      description="条目日期 YYYY-MM-DD，留空取当天")


class ChangelogUpdate(BaseModel):
    """编辑变更日志条目。"""
    title: Optional[str] = None
    content: Optional[str] = Field(None, min_length=1)
    entry_date: Optional[str] = Field(None, pattern=_ENTRY_DATE_RE)
