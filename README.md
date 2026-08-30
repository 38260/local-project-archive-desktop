# 归迹拾光

管理本机散落开发项目的**本地索引库**：记录项目路径、技术栈、笔记与踩坑记录，自动解析 git 信息、构建配置、README 与目录树。B/S 架构内核 + 原生桌面窗口，仅监听 `127.0.0.1`，**所有数据只存在本机，不上传任何云端**；对原项目目录**只读取、绝不写入**。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Python 3.10+ / FastAPI / uvicorn |
| 前端 | Vue 3（本地 vendored，无构建步骤、无 CDN 依赖） |
| 数据库 | SQLite（标准库 `sqlite3`，零额外安装） |
| git | GitPython（只读，任何异常降级为部分结果） |
| 桌面壳 | pywebview（WebView2）+ pystray 系统托盘 |

## 快速启动

**方式一（推荐）**：双击 `start.bat` —— 首次运行自动创建虚拟环境并安装依赖，之后双击即启动。

**方式二（命令行）**：

```bash
# 1. 创建虚拟环境（首次）
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt

# 2. 启动（自动打开浏览器）
.venv/Scripts/python.exe run.py
# 可选参数：--port 9000 指定端口；--no-browser 不自动开浏览器

# 3. 桌面窗口模式：原生窗口 + 系统托盘
.venv/Scripts/python.exe desktop.py
```

浏览器/桌面窗口访问 <http://127.0.0.1:8300>（端口被占自动顺延，仅本机可访问）。

**打包成 exe**：`.venv/Scripts/python.exe -m PyInstaller build.spec --noconfirm`，产物在 `dist/Tracelight/`（方案与细节见 `docs/PACKAGING.md`）。

## 目录结构

```text
local-project-archive-desktop/
├── run.py                  # 浏览器模式入口
├── desktop.py              # 桌面模式入口：pywebview 窗口 + 托盘 + 单实例 + 窗口记忆
├── build.spec              # PyInstaller 打包配置
├── requirements.txt        # 后端依赖
├── app/
│   ├── main.py             # FastAPI 应用：核心 API + 静态页面挂载
│   ├── config.py           # 常量配置（数据目录三态、端口、状态枚举、规模上限）
│   ├── db.py               # SQLite 连接、建表、启动备份
│   ├── models.py           # Pydantic 请求模型
│   ├── routers/
│   │   ├── projects.py     # 项目 CRUD / 置顶 / 提交 / 热力图 / 截图 / 导出 / 打开
│   │   ├── scanner.py      # 批量扫描与导入
│   │   └── settings.py     # 设置 / 备份管理 / 编辑器探测 / 开机自启动
│   ├── services/
│   │   ├── paths.py        # 路径规范化（Windows / WSL UNC / 引号 / ~）
│   │   ├── gitinfo.py      # GitPython 只读读取 git 信息 / 提交 / 热力图聚合
│   │   ├── parser.py       # 磁盘解析：配置文件 / README / 统计 / 目录树
│   │   ├── scanner.py      # 递归扫描发现候选项目
│   │   ├── render.py       # Markdown 渲染 + HTML 基础净化
│   │   ├── settings_store.py  # settings.json 读写（默认值 + 容错 + 原子写入）
│   │   └── autostart.py    # 开机自启动（注册表，仅安装版）
│   └── static/             # 前端（Vue3 本地文件，无构建）
│       ├── dashboard.html  #   首页：统计 / 开发热力图 / 卡片 / 设置
│       ├── project.html    #   详情页：目录树导航 / 面板 / 提交时间线
│       ├── css/style.css   #   亮/暗主题样式
│       └── js/…            #   common / dashboard / project / vendor(vue)
├── data/                   # 运行时生成（git 忽略）
│   ├── projects.db         #   SQLite：项目、笔记、变更日志，重启不丢失
│   ├── backups/            #   启动自动备份（保留份数可在设置中调整）
│   ├── screenshots/        #   项目截图
│   └── settings.json       #   用户设置
└── tools/smoke_test.py     # 全流程冒烟测试（自动造数据、自动清理）
```

## 功能

### 录入与解析

- **手动录入**：粘贴路径，桌面模式下可点「浏览…」打开系统文件夹选择对话框；支持 `D:\code\x`、带引号路径、`~`、`\\wsl.localhost\Ubuntu\…`、`wsl:Ubuntu:/home/user/x`。
- **批量扫描**：指定根目录按 `.git`、`package.json`、`pyproject.toml`、`CMakeLists.txt`、`go.mod`、`Cargo.toml` 等标记发现候选项目，已入库的标记「已导入」，重复导入自动跳过。
- **深度解析**：构建配置（requirements 变体 / setup.cfg / Pipfile / environment.yml / setup.py / Docker 等）+ 依赖清单识别框架（FastAPI/Flask/Django/React/Vue/Next/Electron/Tailwind…）+ 按文件构成推断语言 + README 简介提取；git 读取分支、远端、首次提交时间、贡献者 Top5。解析器升级后可一键「全部重新解析」（保留已有标签，补充新识别）。
- **丢失自愈**：文件夹被删除/移动自动标记【丢失项目】，更新新路径即恢复。

### 浏览与展示

- **首页仪表盘**：状态统计卡（可下钻筛选）、状态/标签/分类筛选、搜索、排序、置顶优先展示、暗色主题。
- **开发活动总览**：首页 GitHub 风格提交热力图，聚合全部仓库按天提交，悬浮显示日期与来源项目，可折叠（半年/一年可调）。
- **项目详情页**：左侧目录树导航（分组可折叠）、右侧目录树只读预览；基础信息、Git 信息、构建配置与依赖、文件统计、项目描述、开发笔记、变更日志、提交记录、截图、README 各成面板。
- **Git 提交可视化**：按月提交柱状图（全量历史聚合、当月高亮，一眼看出开发节奏；跨度半年/一年可调）+ 时间线（哈希/类型/信息/作者/时间，点击展开完整详情）+ 类型筛选。
- **导出**：单项目 HTML 档案报告（自包含单文件，可直接分享/打印）；全库 JSON 备份（含笔记与变更日志），可导入恢复。

### 记录

- **项目描述**：单篇 Markdown（背景/功能/部署），编辑 + 实时预览，草稿本地暂存。
- **开发笔记**：多条独立 Markdown 笔记，可增删改。
- **变更日志**：手写版本改动条目（独立于 git 提交），支持增删改。
- **截图**：项目截图上传（每张 ≤5MB），点击灯箱预览。

### 桌面体验（desktop.py / 安装版）

- 原生窗口 + **系统托盘**：关闭可收进托盘，双击托盘图标唤出；**二次启动直接弹回已有窗口**，不会「提示在运行却找不到」。
- **静默启动**：配合开机自启动，登录后只在托盘待命。
- **窗口记忆**：记住大小与位置，下次启动还原。
- **任务栏/托盘**：应用独立图标与身份（开发模式同样生效）。
- **导出下载**：走系统保存对话框；「浏览…」走原生文件夹选择对话框。

### 数据安全

- 全程只读扫描；描述/笔记/变更日志全部存 SQLite；**每次启动自动备份数据库**（保留份数可调，无变化跳过）。
- 设置面板内置**备份管理**：列表 / 立即备份 / 恢复（恢复前自动留保险备份）/ 删除。
- **危险区**：清空全部档案需输入 `CLEAR` 二次确认（不触碰原项目文件）。

## 设置（应用内面板）

首页顶栏与**项目详情页顶栏**均可打开设置；面板按**「通用 / 桌面 / 数据 / 危险区」四个页签**分区，免长滚动。内容：主题外观（亮/暗/跟随系统）、打开项目的编辑器（自动探测本机可用：VS Code / Cursor / Windsurf…，按钮图标文字联动）、批量扫描默认深度、录入默认状态与分类、默认显示归档项目、提交记录加载数、热力图范围、导出 HTML 是否含笔记、启动自动备份与保留份数、托盘与静默启动、开机自启动（安装版）。

## API 一览（/api/docs 有交互文档）

| 方法 | 路径 | 功能 |
|---|---|---|
| POST / GET | /api/projects | 手动录入 / 列表+统计；GET `/brief` 轻量列表 |
| GET/PUT/DELETE | /api/projects/{id} | 详情 / 更新（含改路径）/ 删除；DELETE `/all` 清空 |
| POST | /api/projects/{id}/pin | 置顶切换 |
| POST | /api/projects/{id}/rescan | 重新解析磁盘 |
| GET | /api/projects/{id}/commits | git 提交记录（`limit`、`date` 按天过滤） |
| GET | /api/projects/{id}/heatmap | 单项目提交热力图（按天聚合） |
| GET | /api/heatmap | 全项目提交热力图聚合 |
| GET/POST | /api/projects/{id}/notes、/changelogs | 笔记与变更日志（PUT/DELETE 同路径） |
| GET | /api/projects/{id}/readme、/tree、/screenshots | README / 目录树 / 截图 |
| POST | /api/projects/{id}/open | 资源管理器 / 所选编辑器打开 |
| GET | /api/projects/{id}/export-html | 导出单项目 HTML 档案报告 |
| POST | /api/scan、/api/scan/import | 批量扫描 / 批量导入 |
| GET/POST | /api/export、/api/import | 导出全库 JSON / 导入恢复 |
| GET/PUT | /api/settings | 设置读写；`/editors` 编辑器探测 |
| GET/POST/DELETE | /api/settings/backups | 备份列表 / 立即备份；`/restore` 恢复 / 删除 |
| GET | /api/health | 健康检查（版本/端口/数据路径） |

## 验证

```bash
# 需先启动服务；脚本创建临时示例项目做全流程冒烟测试，结束后自动清理
.venv/Scripts/python.exe tools/smoke_test.py            # 56 项
```

另有 74 项全功能回归（覆盖设置/备份恢复/热力图/导入导出闭环等），随开发迭代维护。
