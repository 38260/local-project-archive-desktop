# 修改建议 TODO

> 更新日期：2026-08-30
> 来源：全量代码审查（后端 FastAPI + 前端 Vue3 + 桌面打包入口），关键问题已实际启动服务复现；
> 并合并原「设置面板扩展」计划。
> 优先级：🔴 立即修 / 🟠 顺手修 / 🟡 排期做 / ⚪ 可选

---

## 一、Bug 修复

### 🔴 B1. 扫描弹窗「已导入」标记失效（已复现）

- **现象**：批量扫描结果中，已在档案库的项目仍被默认勾选，不显示「已导入」灰标；重复提交后才看到"跳过 N 个"。
- **原因**：前端依赖候选项的 `imported` 字段（`app/static/dashboard.html:267-272`、`app/static/js/dashboard.js:268`），但后端 `/api/scan` 只返回 `path / name / markers`（`app/services/scanner.py:49`），字段不存在。
- **修复**（`app/routers/scanner.py` 的 `scan()`）：

```python
result = scan_root(root, max_depth=body.max_depth)
with get_db() as conn:
    existing = {r["path"].lower() for r in conn.execute("SELECT path FROM projects")}
for c in result["candidates"]:
    c["imported"] = c["path"].lower() in existing
return result
```

- [x] 后端补充 `imported` 字段（2026-08-30 已修复并验证）
- [x] 验证前端灰标与取消勾选生效（前端逻辑已存在，字段补齐即生效）

### 🔴 B2. 变更日志默认日期差一天（UTC 时区问题）

- **现象**：东八区凌晨 00:00–08:00 新建变更日志条目，默认日期显示为昨天。
- **原因**：`app/static/js/project.js:376` 用 `new Date().toISOString().slice(0, 10)`，取的是 UTC 日期。
- **修复**（改用本地年月日）：

```js
const d = new Date();
this.logDraftDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
```

- [x] 修复 `openLogDraft()` 默认日期（2026-08-30 已修复）

### 🔴 B3. FastAPI 422 校验错误 toast 显示 `[object Object]`

- **现象**：参数校验失败（笔记内容为空、日期格式不合法等）时，报错文案是 `[object Object],[object Object]`。
- **原因**：`app/static/js/common.js:96` 直接取 `data.detail` 当文案，但 422 的 `detail` 是对象数组。
- **修复**（`common.js` 的 `api()` 内）：

```js
let msg = `请求失败（HTTP ${resp.status}）`;
const d = data && data.detail;
if (typeof d === "string") msg = d;
else if (Array.isArray(d) && d.length) msg = d[0].msg || msg;
```

- [x] `api()` 兼容数组形式的 detail（2026-08-30 已修复并验证）

### 🔴 B4. 手动录入 / 改路径时解析异常裸 500

- **现象**：项目目录无权限或 IO 错误时，"录入并解析"返回"请求失败（HTTP 500）"。
- **原因**：
  - `app/routers/projects.py:137` `create_project` 中 `parser.parse_project(path)` 未捕获 `OSError`（对比 `rescan_project` 捕获后返回 502）；
  - `app/routers/projects.py:249` `update_project` 改路径后调用 `_parse_and_store` 同样未捕获。
- **修复**：两处套 `try/except OSError → HTTPException(502, f"解析失败（目录无权限或 IO 错误）：{exc}")`。
- [x] `create_project` 捕获解析异常（2026-08-30 已修复并验证）
- [x] `update_project` 的 `_parse_and_store` 捕获解析异常（同上）

### 🟠 B5. Node 项目「依赖版本统计」全部算成"未标注"

- **现象**：详情页"固定版本 0 · 范围约束 0 · 未标注版本 N"，Node 项目永远如此。
- **原因**：`app/services/parser.py` `_parse_package_json` 只取依赖名（`.keys()`），丢掉版本约束；`depStats`（`project.js:197`）靠 `==` / `^~>` 分类。
- **修复**：保留版本串：

```python
deps = [f"{k}@{v}" for k, v in (data.get("dependencies") or {}).items()]
dev_deps = [f"{k}@{v}" for k, v in (data.get("devDependencies") or {}).items()]
```

（前端 `isRange` 已能识别 `^`/`~`；修复后需"全部重新解析"一次才生效。）

- [x] 依赖保留版本约束（2026-08-30 已修复并验证，前端分类同步支持 `@精确版本`）
- [x] 重新解析验证统计正确（新录入即生效；存量项目点一次"全部重新解析"）

### 🟠 B6. 提交记录"已加载全部"文案自相矛盾

- **现象**：`app/static/project.html:506-507`，`total_count > commits.length` 且已到 200 条上限时显示"已加载全部 N 条"——实际没加载全部。
- **修复**：改为

```
已加载最近 {{ commitData.commits.length }} 条，共 {{ fmtNum(commitData.total_count) }} 次提交（后端单次上限 200 条）
```

- [ ] 修正文案

### 🟡 B7. 其他小问题清单

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 7.1 | `app/db.py:90` | `sqlite3.connect` 无 timeout，并发写会 `database is locked` | `sqlite3.connect(DB_PATH, timeout=15)` ✅已修复 |
| 7.2 | `app/routers/projects.py:567` | `_shot_list` 中 `f.stat()` 遇并发删除会 500 | 单文件套 try/except 跳过 |
| 7.3 | `app/routers/projects.py:597` | 截图上传先整读入内存再校验 5MB，超大文件吃内存 | 分块读取，超限提前终止 |
| 7.4 | `app/static/js/project.js:106` | `_descTimer` 放在 `data()`，`_` 前缀属性不被 Vue 代理 | 移出 data，放入 methods 闭包 |
| 7.5 | `run.py:33` | 固定端口 8300 被占用即启动失败 | 复用 `config.pick_port()` |
| 7.6 | `app/services/gitinfo.py:139` | 每条提交算 `commit.stats`（全量 diff），大仓库 200 条需数秒 | 改 `git log --numstat` 命令行一次取回 |
| 7.7 | `app/static/js/project.js:321` | 详情页为左右切换调全量 `/api/projects`（每项目都做磁盘 live_check） | 后端加轻量接口只返回 id/name |
| 7.8 | `app/services/render.py` | 正则净化有绕过面（`<svg/onload=...>`、无引号 `href=javascript:`） | 本地风险低；若要分享导出 HTML，换 `nh3`/`bleach` |
| 7.9 | `app/main.py` | 无 Origin 校验，恶意网页可对 127.0.0.1 的 GET 接口发起请求 | 加校验 `Origin`/`Host` 的中间件 |
| 7.10 | `app/main.py:163` | `@app.on_event("startup")` 已废弃 | 迁移到 lifespan |

- [ ] 7.1 ~ 7.10（可拆成独立小提交）

---

## 二、性能与架构改进

- 🟡 **`list_projects` 全量磁盘校验**：每次首页逐个 `os.path.isdir`；项目多或含失联网络盘/WSL 时可能挂起数秒。建议加超时，或后台定期校验 + 请求时直接读标记。
- 🟡 **`rescan-all` 同步长请求**：全部项目一个请求串行等完，无进度。建议任务化轮询进度或分批提交。
- ⚪ **`init_db()` 每次启动全量复制备份**：数据库变大后启动变慢。建议比对哈希/大小，无变化跳过。

---

## 三、UI 美化建议

1. ⚪ **顶栏按钮收纳**：6 个并排偏挤。保留「手动录入（主）+ 批量扫描」，"全部重新解析、导出 JSON"收进"工具"下拉菜单。
2. ⚪ **统一危险确认弹窗**：删笔记 / 删截图 / 删档案 / 重新解析等 6 处仍用原生 `confirm()`。复用现有 `.modal` 做确认组件，危险按钮用 `--danger`。
3. ⚪ **卡片操作按钮可发现性**：`row-actions` 默认 opacity .45，触摸/键盘用户难发现；`:focus-visible` 时满显。
4. ⚪ **页脚文案可操作化**："档案持久化保存于本机：路径"做成可点击 → 复制路径 / 打开数据目录。
5. ⚪ **搜索框细节**：有内容时加 ✕ 清除按钮；右侧 `<kbd>/</kbd>` 角标提示快捷键。
6. ⚪ **详情页基础信息瘦身**：6 个 info-tile 平铺略单调，"档案建立/更新"合并为一行小字。
7. ⚪ **统计卡数字间距**：`<b>37</b>全部项目` 连读，数字与文字间加 6px gap。
8. ⚪ **暗色丢失徽标**：`.badge.lost` 实色刺眼，暗色下降为 90% 亮度。

---

## 四、设置功能补全（当前仅有"开机自启动"）

### 0. 前置地基：通用设置持久化层（必做，排第一）

除自启动（注册表）与主题（localStorage）外，当前**没有任何通用设置存储**。
新增设置项前必须先补这一层，否则每个设置都得各写一套存储。

- [ ] 新增 `app/services/settings_store.py`
  - 读写 `DATA_DIR/settings.json`（随用户数据目录，重装不丢）
  - 提供 `get(key, default)` / `set(key, value)` / `all()`，带默认值与容错（文件损坏回退默认）
- [ ] 扩展 `app/routers/settings.py`：新增 `GET/PUT /api/settings`（通用键值读写）
- [ ] 前端：设置弹窗增加通用开关/输入绑定（复用现有 `.switch` 与 `toggleXxx` 模式）

### 高优先：数据闭环

1. 🔴 **导入 JSON 备份**：最大缺口——有导出无导入，换机/恢复做不了。新增 `POST /api/import`（按 path 去重：已存在则合并/跳过可选）。入口放设置"维护"区。
2. 🟠 **备份管理**：显示 `data/backups` 份数；"立即备份"按钮；开关 `backup.enabled` + 保留份数 `backup.keep`（替代硬编码 10）；从指定备份恢复。
3. 🟠 **数据目录与日志**：设置页"打开数据文件夹"按钮 → `GET /api/settings/open-data-folder` → `os.startfile(DATA_DIR)`；"打开日志文件"按钮。

### 中优先：桌面行为与体验

4. 🟠 **关闭窗口行为**：退出 vs 最小化到系统托盘（`pystray` 或 pywebview 隐藏窗口）。与自启动强耦合：自启动后无窗口必须靠托盘唤出。
5. 🟠 **自启动静默启动**：自启动时最小化/后台启动开关（否则每次登录弹窗打扰）。
6. 🟠 **记住窗口大小/位置**：现固定 `1440×900`（`desktop.py`）；关闭时写 `settings.json`，下次还原。
7. 🟠 **默认外部编辑器**：目前写死 `code`。支持 VS Code / Cursor / JetBrains / 自定义命令。
8. 🟡 **默认扫描深度持久化**：`scan.default_depth`，打开扫描弹窗时读取（现每次重置为 3）。
9. 🟡 **记住上次扫描根目录**。
10. 🟡 **启动自动刷新项目状态**：开关 `scan.refresh_on_start`（默认关），启动后自动跑"路径丢失"检测。
11. 🟡 **默认录入值**：手动录入/扫描导入的默认状态、默认分类。

### 低优先：锦上添花

12. ⚪ 项目置顶选项。
13. ⚪ 归档项目默认显示：偏好 `ui.show_archived_default`（现默认隐藏）。
14. ⚪ 主题三态收进设置面板（顶栏轮转按钮保留，两处同步）。
15. ⚪ 显示当前版本号与服务端口（现在只在 `/api/health`）。
16. ⚪ 危险区：清空全部档案（二次输入确认）。

---

## 建议执行顺序

1. **第一批（小改动，高收益）**：B1、B2、B3、B4 + 7.1（sqlite timeout）
2. **第二批**：B5、B6、B7 其余项
3. **第三批**：设置持久化层（四-0）→ 导入 JSON 备份 + 备份管理 + 打开数据文件夹
4. **第四批**：桌面行为（托盘 / 静默自启动 / 窗口记忆）+ 性能项（提交记录、轻量列表、live_check 优化）
5. **第五批**：UI 打磨与低优先设置项

> 模式约定：新增设置项沿用现有 `GET/PUT` 路由 + 前端 `toggleXxx` + 注册表（仅自启动）或 `settings.json`（其余）的既有模式。
