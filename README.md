# 本地项目档案管理系统

管理本机散落开发项目的**本地索引库**：记录项目路径、技术栈、笔记与踩坑记录，自动解析 git 信息、构建配置、README 与目录树。B/S 架构，仅监听 `127.0.0.1`，**所有数据只存在本机，不上传任何云端**；对原项目目录**只读取、绝不写入**。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Python 3.10+ / FastAPI / uvicorn |
| 前端 | Vue 3（本地 vendored，无构建步骤、无 CDN 依赖） |
| 数据库 | SQLite（标准库 `sqlite3`，零额外安装） |
| 依赖 | `pathlib` 路径处理，GitPython 读取 git 信息 |

## 快速启动

**方式一（推荐）**：双击 `start.bat` —— 首次运行自动创建虚拟环境并安装依赖，之后双击即启动。

**方式二（命令行）**：

```bash
cd local-project-archive

# 1. 创建并激活虚拟环境（首次）
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt

# 2. 启动服务（自动打开浏览器）
.venv/Scripts/python.exe run.py
# 可选参数：--port 9000 指定端口；--no-browser 不自动开浏览器
```

浏览器访问 <http://127.0.0.1:8300>（仅本机可访问）。

## 目录结构

```text
local-project-archive/
├── run.py                  # 启动入口
├── requirements.txt        # 后端依赖
├── app/
│   ├── main.py             # FastAPI 应用：API 路由 + 静态页面挂载
│   ├── config.py           # 常量配置（端口、状态枚举、扫描/树规模上限）
│   ├── db.py               # SQLite 连接与建表
│   ├── models.py           # Pydantic 请求模型
│   ├── routers/
│   │   ├── projects.py     # 项目 CRUD / 重解析 / README / 目录树 / 打开
│   │   └── scanner.py      # 批量扫描与导入
│   ├── services/
│   │   ├── paths.py        # 路径规范化（Windows / WSL UNC / 引号 / ~）
│   │   ├── gitinfo.py      # GitPython 只读读取 git 信息
│   │   ├── parser.py       # 磁盘解析：配置文件 / README / 统计 / 目录树
│   │   ├── scanner.py      # 递归扫描发现候选项目
│   │   └── render.py       # Markdown 渲染 + HTML 基础净化
│   └── static/             # 前端（Vue3 本地文件，无构建）
│       ├── dashboard.html  #   首页仪表盘
│       ├── project.html    #   项目详情页
│       ├── css/style.css   #   亮/暗主题样式
│       └── js/…            #   common / dashboard / project / vendor(vue)
└── data/                   # 运行时生成（git 忽略）—— 档案持久化保存在这里
    ├── projects.db         #   SQLite 数据库：项目、笔记、变更日志全在此，重启不丢失
    └── backups/            #   每次启动自动备份（保留最近 10 份）
```

## 数据表结构（projects）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 项目 ID（详情页 `/project/{id}`） |
| path | TEXT UNIQUE | **核心字段**，规范化绝对路径（不区分大小写唯一） |
| name / alias | TEXT | 项目名称 / 别名 |
| category | TEXT | 项目分类（自由文本） |
| status | TEXT | 进行中 / 已完成 / 暂停 / 归档废弃 |
| tags | TEXT(JSON) | 技术栈标签数组（录入时可自动识别） |
| description | TEXT | 用户 Markdown 项目描述（背景/功能/部署命令，存数据库，**不写入原项目**） |
| auto_meta | TEXT(JSON) | 自动解析元数据：git 信息、构建配置、文件统计、技术栈 |
| is_lost / lost_reason | INTEGER / TEXT | 路径失效标记与原因（丢失项目） |
| fs_created / fs_modified | TEXT | 磁盘创建 / 最后修改时间 |
| created_at / updated_at | TEXT | 档案建立 / 更新时间 |

**表 `notes`（自定义开发笔记）**：`id`、`project_id`（FK→projects，级联删除）、`content`（Markdown）、`created_at`、`updated_at`。多条独立笔记，自动记录创建时间。

**表 `changelogs`（自定义变更日志）**：`id`、`project_id`（FK→projects，级联删除）、`title`、`content`（Markdown）、`entry_date`（条目日期，默认当天可改）、`created_at`、`updated_at`。用户手写，独立于 git 提交记录。

## API 一览（/api/docs 有交互文档）

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | /api/projects | 手动录入（路径校验 + 自动解析） |
| GET | /api/projects | 列表 + 统计（实时校验路径有效性） |
| GET/PUT/DELETE | /api/projects/{id} | 详情 / 更新（含改路径）/ 删除档案 |
| POST | /api/projects/{id}/rescan | 重新解析磁盘 |
| GET | /api/projects/{id}/commits?limit=50 | git 提交记录（时间线可视化数据） |
| GET/POST | /api/projects/{id}/notes | 开发笔记列表 / 新建 |
| PUT/DELETE | /api/projects/{id}/notes/{nid} | 编辑 / 删除笔记 |
| GET/POST | /api/projects/{id}/changelogs | 变更日志列表 / 新增 |
| PUT/DELETE | /api/projects/{id}/changelogs/{lid} | 编辑 / 删除条目 |
| GET | /api/projects/{id}/readme | 渲染 README |
| GET | /api/projects/{id}/tree | 目录树只读预览 |
| POST | /api/projects/{id}/open | 资源管理器 / VSCode 打开 |
| POST | /api/scan、/api/scan/import | 批量扫描 / 批量导入 |
| GET | /api/export | 导出全部档案 JSON（含笔记与变更日志） |
| POST | /api/render-md | Markdown 预览渲染 |

## 功能说明

- **录入**：手动填路径，或指定根目录批量扫描（按 `.git`、`package.json`、`pyproject.toml`、`CMakeLists.txt`、`go.mod`、`Cargo.toml` 等标记识别，自动跳过 node_modules、构建产物）。
- **路径兼容**：`D:\code\x`、带引号路径、`~`、`\\wsl.localhost\Ubuntu\…`、`wsl:Ubuntu:/home/user/x`。
- **丢失项目**：文件夹被删除/移动后自动标记【丢失项目】并高亮，详情页可一键更新新路径并重解析。
- **项目描述**：单篇 Markdown（项目背景/实现功能/运行部署命令），编辑 + 预览。
- **开发笔记**：多条独立 Markdown 笔记（体会/心得/踩坑/解决方案），自动记录创建时间，可编辑、删除。
- **Git 提交可视化**：提交时间线（哈希/信息/作者/时间），点击展开完整详情（完整哈希、邮箱、变更规模），按月简易统计柱状图；非 git 仓库显示提示。
- **变更日志**：用户手动编写的 Markdown 条目（版本改动/功能新增/重大调整），自带日期时间戳，与 git 提交记录相互独立，支持增删改。
- **异常安全**：无权限目录、损坏 git 仓库、超大项目（统计/目录树有上限）均友好降级，不崩溃服务。
- **数据安全**：全程只读扫描；描述/笔记/变更日志全部存 SQLite；导出 JSON 备份包含项目元数据、全部笔记与变更日志。

## 验证脚本

```bash
# 需先启动服务；脚本会创建临时示例项目做全流程冒烟测试，结束后自动清理
.venv/Scripts/python.exe tools/smoke_test.py
```
