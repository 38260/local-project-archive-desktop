# 归迹拾光（local-project-archive-desktop）Bug 审查报告

> 审查日期：2026-08-30
> 审查对象：当前 HEAD（`49250b5 feat: 快速启动`，含 launcher 快速启动 + 此前设置/桌面功能）
> 方法：后端执行链逐行自审 + Explore 子代理全量兜底（scanner / db / settings / models / 前端公共 JS）
> 范围：用户选择「全量代码静态审查 + 桌面打包与启动」

---

## 🔴 必须修（会真实出错 / 安全绕过）

### 1. 批量导入错误边界脆弱 → 整批 500 并回滚
- **位置**：`app/routers/scanner.py:67` 与 `:72-80`
- **现象**：
  - `except OSError` 过窄。`parse_project()` 内部 `datetime.fromtimestamp(st.st_mtime)` 在异常 mtime（某些解压归档 / 异常文件系统年份超范围）会抛 `OverflowError`/`ValueError`，不被捕获 → 整个 `/api/scan/import` 裸 500。
  - 主 `try` 在 `parse_project` 处结束，而 `INSERT INTO projects` 在其**之外**、无 `IntegrityError` 保护。并发两次导入同一路径（或 rescan-all 与导入竞态）使 `path` UNIQUE 约束冲突 → `IntegrityError` 裸 500。
- **影响**：批量导入中途一条异常，前面已成功插入的全部回滚（同一 `with get_db()` 事务），用户看到"导入失败"但部分数据丢失。
- **修复**：
  ```python
  try:
      parsed = parser.parse_project(path)
  except Exception as exc:          # 放宽到 Exception，与 parse_project「子步骤不中断整体」契约一致
      failed.append({"path": path, "reason": f"解析失败：{exc}"})
      continue
  # INSERT 也纳入 try，捕获 IntegrityError
  try:
      cur = conn.execute(...)
      created_ids.append(cur.lastrowid)
      existing.add(path.lower())
      imported += 1
  except sqlite3.IntegrityError as exc:
      failed.append({"path": path, "reason": f"写入冲突：{exc}"})
  ```

### 2. HTML 净化对实体编码绕过（XSS）
- **位置**：`app/services/render.py:38-39`（`sanitize_html`）
- **现象**：危险协议校验 `_JS_URL_RE` 要求字面 `javascript:`/`data:` 紧跟（可选空白后 `:`）。攻击载荷 `href="javascript&#x3A;alert(1)"` 或 `href="data&#x3A;text/html,..."` 中的 `&#x3A;` 是实体，不被正则命中 → 放行；浏览器解码后点击即执行脚本。
- **影响**：本地渲染第三方 README / 用户笔记时的 XSS（本机单用户威胁偏低，但既然已做净化层，应闭合该面）。
- **修复**：净化前先 `import html; html.unescape(s)` 再校验；或将 `xlink:href` 纳入危险属性；更稳妥直接换 `bleach` 库做净化。

---

## 🟡 建议修（功能偏差 / 健壮性）

### 3. 目录树文件节点 `rel` 丢失文件名
- **位置**：`app/services/parser.py:494`
- **现象**：`build_tree` 文件节点 `"rel": rel` 用的是**父目录**的 `rel`，导致前端"复制相对路径"点到文件时复制的是父文件夹路径。
- **修复**：`"rel": rel + "/" + name`。

### 4. 设置写入无类型/键白名单
- **位置**：`app/services/settings_store.py:76` + `app/routers/settings.py:57`
- **现象**：`put_settings` 仅校验字符串长度，接受任意键与任意类型值。写入与 `DEFAULTS` 类型不一致（如本应 number 收到 string、未知键）后，读取端按既定类型使用出现静默偏差。
- **修复**：按 `DEFAULTS` 做键白名单 + 类型强制转换。

### 5. 备份恢复无全局写锁
- **位置**：`app/routers/settings.py` `restore_backup`（`shutil.copy2(src, DB_PATH)`）
- **现象**：恢复备份与其他请求并发写同一 DB 文件时，Windows 可能 `PermissionError`（→502）或覆盖半截文件导致恢复出的库损坏。
- **修复**：恢复前短暂串行化写入（或先备份再原子替换）。

### 6. 前端 `launch_project` 对 `body.mode` 无白名单
- **位置**：`app/routers/projects.py:673` `launch_project`
- **现象**：`body.mode` 为任意字符串时静默走 console 兜底（命令仍经 `cmd /k` 执行，安全但未按预期语义）。属健壮性瑕疵。
- **修复**：`mode = body.mode if body.mode in ("open","console") else "console"` 或非法即 422。

### 7. `dashboard.js:353` 录入成功提示缺可选链
- **位置**：`app/static/js/dashboard.js:353`
- **现象**：`p.auto_meta.configs.length` 在后端缺 `configs` 键时会 `TypeError`。当前 `create_project` 总是返回含 `configs` 的 `auto_meta`，正常流程不触发，但属脆弱点。
- **修复**：`p.auto_meta?.configs?.length ?? 0`。

---

## ✅ 已确认健康（重点审查，未见缺陷）

- **快速启动执行链**：`_clean_launch_command`（禁换行/限长）、`_resolve_launch_cwd`（越界拒绝，含 `..` 与绝对路径）、`launch_project` 的 WSL/UNC 拒绝、`os.startfile` 与 `subprocess.Popen(["cmd","/k",...], CREATE_NEW_CONSOLE)` 用法、`GET/POST /launch` 路由不冲突 —— 设计到位。
- **前端 launch 面板**：`runEntry` 确认弹窗 + `launcher_id`/`command+mode+cwd` 分流正确，suggestion 的 `mode`/`cwd` 与后端一致。
- **gitinfo**：全部走 GitPython（`Repo(path)`、`repo.git.log`），非 shell 拼接，path 不进命令行，无注入面。
- **db / 并发**：`sqlite3.connect(timeout=15)`、连接按请求开关、`list_projects` 8 线程 live_check、`_row_to_dict` 自愈丢失标记 —— 基础扎实。
- **桌面打包**：`desktop.py` 单实例互斥体、托盘隐藏、几何持久化防抖、`build.spec` hiddenimports 覆盖 uvicorn/git/webview/pystray —— 未见致命缺漏。

---

## 修复优先级（Top Picks）

1. **先修 #1（scanner 导入错误边界）** —— 影响最大、最易被并发/异常文件触发，且会让批量导入"假失败+部分回滚"。改动小、风险低。
2. **再修 #2（render XSS 绕过）** —— 安全闭环，一行 `html.unescape` 即可补；即便本地单用户也建议闭合。
3. **顺手修 #3（build_tree rel）** —— 一行改动，修复"复制相对路径"得到错误路径的交互 bug。
4. **排期 #4/#5/#6/#7** —— 健壮性，按节奏纳入。

> 一句话结论：主流程与 launcher 执行链健康，但**批量导入错误边界**和 **HTML 实体编码 XSS 绕过**是两条确定会出问题的真缺陷，建议优先修这两条。
