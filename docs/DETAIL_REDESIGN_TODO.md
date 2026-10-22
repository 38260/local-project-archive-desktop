# 项目详情页改版设计 TODO

更新日期：2026-10-23

当前阶段：设计材料已完成，详情页 F1～F5 正在实施；首页改版已独立完成并提交（HEAD `eb4cf8b`），本任务不覆盖、不混入首页提交。

## 实施进度

| 分项 | 内容 | 状态 |
| --- | --- | --- |
| F1 | 紧凑项目头部、统一默认 Logo、信息去重、主次操作 | [x] 已完成（2026-10-23） |
| F2 | 四个内容分区、页内锚点、草稿/筛选/折叠/阅读位置保护 | [x] 已完成（2026-10-23） |
| F3 | 概览真实数据（最近进展/笔记/启动/README）与全部跳转 | [x] 已完成（2026-10-23） |
| F4 | 目录树按需侧栏、关闭释放整列、焦点与键盘 | [x] 已完成（2026-10-23） |
| F5 | 主题/响应式、完整回归与截图验收 | [x] 已完成（2026-10-23） |

本地验证环境：Windows + Git Bash，Python 3.12（`.venv`），Node.js 24，Chrome/Playwright。所有写入测试先经 `tools/isolated_instance.py`；禁止对正式 `data/projects.db` 写入或清理。

## 设计交付

- [x] D1：依据当前详情模板、已有截图及首页第二版，确定紧凑项目头部、四个内容分区、宽正文与按需目录树。
- [x] D2：使用内置 imagegen 生成详情页“概览”预览，保存 PNG 和完整提示词。
- [x] D3：目视核对关键区域、文件完整性、文档引用与变更范围，交付本次设计材料。
- [x] D4：整理供另一个 AI 实施的完整开发提示词，在开头加入详情页参考图，明确真实数据、草稿保护、功能保留、分项提交及验收要求。

## 布局约定

- 保留全局项目标签与品牌；侧栏为项目内部导航：概览、启动与运行、开发记录、项目资料。
- 顶部名片统一 Logo、标题、简介、状态、标签、分支与操作；路径只保留一处。仅“启动”作为主按钮。
- 概览包含最近进展、最近笔记、常用启动和 README 简介；完整日志、记录、资料仍在各自分区中。
- 目录树以关闭状态的按需入口展示，不常驻右栏、不保留空白占位。
- 统计、笔记、启动项、时间、路径均为图中演示内容；不把设计图当作真实运行截图或已实现功能。
- 新版首页参考：[homepage-redesign-v2.png](designs/homepage-redesign-v2.png)。
- 完整提示词：[project-detail-redesign-v1.prompt.md](designs/project-detail-redesign-v1.prompt.md)。
- 详情页预览：[project-detail-redesign-v1.png](designs/project-detail-redesign-v1.png)。
- 完整开发交接（含参考图）：[project-detail-implementation-prompt.md](designs/project-detail-implementation-prompt.md)。

## 后续实现建议

- [x] F1：紧凑项目头部、统一默认图标、去除重复信息与操作优先级。
- [x] F2：四个内容分区与页内定位，切换时保留编辑草稿、筛选、折叠及阅读位置。
- [x] F3：概览接入真实最近提交、笔记预览、现有启动入口与 README 摘要；不新增 AI 总结或推断工时。
- [x] F4：目录树按需开关、关闭后释放整列空间，保留原有文件预览能力。
- [x] F5：亮暗主题、宽窄窗口、键盘交互、自动更新和未保存内容保护的隔离回归与实际验收。

## 起始状态与范围

- 起始 HEAD：`1955ffb`。工作区已有 `app/services/settings_store.py`、`app/static/js/dashboard.js` 未提交修改，视为其他进行中工作，保留且不纳入本次提交。
- 首页实现正在并行推进，其他文件可能随后变化；本轮只新增本 TODO、详情预览 PNG 和提示词，提交时逐项限定文件范围。
- 不启动应用、不写真实数据库、不打包，也不以历史测试记录代替本轮验收。

## 设计材料检查

- 内置 `image_gen.imagegen` 单张新生成，无图片输入；已将原始 PNG 复制进项目，未后处理或覆盖旧图片。
- 尺寸：1536 × 1024px；文件长度：1,304,941 bytes。
- SHA-256：`1dbcff82caad2c10933d4e00b53a523cf0980d0aba7aceb34963d227432c0191`。
- 目视核对：项目标签栏、四个分区、单一蓝色主按钮、唯一项目路径、关闭的目录树入口、最近提交与笔记、两项启动入口、README 简介及底部内容均可见。
- 统计源示例：近 7 天为 `0, 4, 5, 0, 6, 3, 0`，合计 18 次、4 个活跃日；图中显示对应总量。图片不作为真实数据渲染或交互验收。
- 材料完整性检查通过：原图复制一致性、PNG 尺寸/长度/哈希、本地链接、待办未实施状态及本次文件范围均已核对；未执行应用功能测试。
- 设计预览提交：`e5b3c26`。开发提示词只做静态核对，未调用其他 AI 或实际执行其中的开发任务；所有实现待办继续保留为未完成。

## F1 验证记录（2026-10-23）

- 起始 Git：`main`，HEAD `eb4cf8b`；工作区干净，首页 F6 已完成并提交。
- 修改：`project.html` 重构项目头部（Logo、名称/别名/简介/状态/分类/标签/分支、唯一路径与行内复制、最近修改、更多信息）；删除基础信息与独立 Git 信息面板，Git 元信息移入“更多信息”；`project.js` 增加与首页一致的字母/缩写规则、稳定配色、头部摘要与折叠逻辑；`style.css` 增加头部与移动端样式。
- 主次操作：启动为唯一 `.btn.primary`（含下拉选择默认入口）；编辑器打开、资源管理器、更多为次级按钮；复制路径改为路径行内操作；编辑档案移入“更多”菜单，重新解析/置顶/导出/删除保留。
- 降级：路径丢失时路径与打开按钮禁用；无启动入口时蓝色启动按钮禁用并给出原因；环境不支持时同样禁用。
- 测试：`tools/test_detail_prepare.py` 在隔离实例中复用 10 个真实项目并补 Tracelight 启动项、启动说明、3 条笔记与变更日志；`node tools/test_detail_f1_browser.cjs %TL_STATE%`（经 isolated_instance）通过：标题/Logo/别名/简介/分类/标签/分支、路径唯一、启动主按钮、次级操作、更多菜单五项、更多信息时间与 Git 元信息、无启动入口禁用、控制台无错误。
- 截图：`docs/evidence/detail-redesign/detail-f1-1440.png`。
- 未执行：编辑器/资源管理器真实调用系统应用（会启动外部程序，留待人工验收）；状态切换、草稿保护和完整链路在 F2/F5 验证。

## F2 验证记录（2026-10-23）

- 起始 Git：`main`，HEAD `9f7b524`，工作区干净。
- 修改：`project.html` 左侧改为项目内部导航（概览/启动与运行/开发记录/项目资料 + 当前分区页内锚点），内容以 `v-show` 分区常驻；新增概览占位分区；`project.js` 增加分区/锚点映射、切换时保存并恢复阅读位置、旧锚点先切分区再定位、按需展开个人记录；`common.js` 仅新增 home/play 两个图标；`style.css` 增加导航、窄屏横向 chip 与锚点样式。
- 状态保护：分区只是 `v-show`，描述编辑器、笔记草稿、变更日志草稿、启动说明草稿、记录展开状态、提交作者筛选、月图折叠均留在同一组件实例中；分区切换不调用 leaveConfirm；离开项目仍走原 leaveConfirm。
- 测试命令：`tools/isolated_instance.py --repo . --run ".venv\\Scripts\\python.exe tools/test_detail_prepare.py %TL_STATE% && node tools/test_detail_f2_browser.cjs %TL_STATE%" --cwd repo` → 通过：默认概览、四分区切换、锚点列表、描述/笔记/日志/启动说明四类草稿跨区保留、作者筛选与折叠保留、阅读位置恢复、未保存时离开确认、`#sec-commits` 旧锚点先切开发记录再定位、控制台无错误。
- 截图：`docs/evidence/detail-redesign/detail-f2-1440.png`。
- 未执行：窄屏导航、亮暗主题与完整响应式在 F5；目录树按需抽屉在 F4，当前仍保留旧右栏。

## F3 验证记录（2026-10-23）

- 起始 Git：`main`，HEAD `47ba7eb`，工作区干净。
- 后端：`GET /api/projects/{id}/heatmap` 最小扩展 `window_days`（1～90）与 `tz=commit|local`，旧 `weeks` 月图口径与默认值不变；概览调用 `window_days=7&tz=local&authors=mine`，与开发记录的作者筛选隔离。
- 概览：最近进展（7 个本地日历日含零提交、提交数/活跃日、项目稳定主色柱、最多 3 条按提交时间倒序的本人提交）、最近笔记（最新 3 条，纯文本标题/时间/两行预览，完整内容仍在开发记录）、常用启动（`orderedEntries` 前 3 个，默认入口标识，复用 runEntry 确认/忙碌/失败逻辑）、README 纯文本摘要。全部入口切分区并定位；“新增笔记”打开现有编辑器并聚焦。
- 状态：缺邮箱显示设置引导；非 Git 项目优先显示“不是 Git 仓库”；真实 Git 空窗口显示 0/0 与零柱；请求失败显示错误和重试，不伪装为零；路径丢失单独提示。
- 测试：`tools/isolated_instance.py --repo . --run ".venv\\Scripts\\python.exe tools/test_detail_prepare.py %TL_STATE% && node tools/test_detail_f3_browser.cjs %TL_STATE%" --cwd repo` → 通过（API total=4/window_days=7、概览 4 次/3 活跃日/7 桶/3 条提交/3 条笔记/启动默认入口/README 摘要、六个跳转链路、缺邮箱、非 Git、空窗口、故障注入 + 重试、控制台无未预期错误）。
- 夹具新增：`QuietRepo` 为真实 Git 仓库但 7 天内无提交；`test_detail_prepare.py` 仍只在隔离目录内操作。
- 截图：`docs/evidence/detail-redesign/detail-f3-1440.png`（右侧目录树仍为 F4 前的旧实现）。
- 未执行：启动按钮真实执行命令（会拉起外部进程，留待人工验收）；窄屏/暗色在 F5。

## F4 验证记录（2026-10-23）

- 起始 Git：`main`，HEAD `42c608c`，工作区干净。
- 修改：`project.html` 顶部新增“目录树”入口，移除常驻右侧目录树列，改为带遮罩的右抽屉；`project.js` 改为按需懒加载（关闭时不扫描 `/tree`）、抽屉开关持久化、打开时聚焦关闭按钮、Esc 关闭并由 `v-modal` 归还焦点、自动刷新/重新解析时仅在打开状态刷新目录；`style.css` 主区改为“左导航 + 正文”两列，新增抽屉样式。
- 保留交互：目录展开/收起、父目录状态、单击复制相对路径、双击交给系统默认应用（测试中拦截了 `open-file`，未实际拉起外部程序）、截断提示、只读边界不变。
- 测试：`tools/isolated_instance.py --repo . --run ".venv\\Scripts\\python.exe tools/test_detail_prepare.py %TL_STATE% && node tools/test_detail_f4_browser.cjs %TL_STATE%" --cwd repo` → 通过：初始无树请求、两列布局、打开后加载、焦点进入、目录展开、单击复制、双击 open-file、Esc 关闭与焦点归还、正文宽度不因抽屉改变、打开偏好刷新保持/关闭偏好刷新消失、键盘打开、390px 抽屉在视口内且无横向溢出、控制台无错误。
- 截图：`docs/evidence/detail-redesign/detail-f4-tree.png`。
- 未执行：真实拉起系统默认应用打开文件（测试通过拦截验证请求）；F5 再做载入/空/失败状态和全宽度截图。

## F5 验证记录（2026-10-23）

- 起始 Git：`main`，HEAD `8deeb1d`，工作区干净。
- 视觉：详情顶栏改用与首页一致的品牌方块 + 双行品牌，保留返回/相邻项目/目录树/设置/主题；导航、面板、时间与标签继续使用主题变量。修正窄屏 `detail-nav` 残留最小高度造成的大块空白；「本页内容」顺序调整为与真实内容一致（流程图 → 构建配置 → 文件统计 → 项目截图 → README）。
- 共享组件修复：标签页拖动只允许从 `.tab-handle` 起手，标签名称恢复可拖选复制；首页/详情均在 390 下有合理换行且无横向溢出。
- 新验收：`tools/test_detail_final_browser.cjs` 通过：品牌与入口、路径内联复制、状态修改/恢复、更多菜单五项、分区切换不重复访问、README 相对链接应用内预览、四分区 1440 截图、概览 1920/1440/1280/1024/768/390 亮色与 1440/390 暗色、390 四分区无横向溢出、控制台与失败请求为空。
- 既有回归：`test_auto_refresh_detail.py` 全部通过（简介/统计/提交徽章更新、四类草稿保护、切换项目不串数据、focus 合并、失败重试）；`test_readme_langs.cjs` 6 项通过；`test_browser_r11.cjs` 12 组通过（SVG 隔离、流程图上传/恢复/导出、默认启动入口、偏好失败回退、弹窗拖选、文字选择、首页排序、亮暗宽度）；`test_browser_fixes.cjs` 7 类文字拖选/标签拖动通过；个人贡献 API + 浏览器链路通过；`test_project_launch.cjs` 通过；`test_home_final_browser.cjs` 在共享 CSS/JS 改动后重跑通过；JS 单测与 12 项 Python unittest 通过；`git diff --check` 通过。
- 截图：`docs/evidence/detail-redesign/detail-overview-{1920,1440,1280,1024,768,390}-light.png`、`detail-overview-{1440,390}-dark.png`、`detail-{launch,records,materials}-1440-light.png`；结果 `detail-final-browser.json`。目录树截图见 F4。
- 未执行：桌面 WebView2 实机验证（现有脚本会使用正式 `data/` 并触发自动刷新写入，按隔离护栏本轮不运行）；PyInstaller 重新打包和安装包安装验证；真实编辑器/资源管理器/系统默认应用启动、真实启动命令执行、截图上传与运行历史产生（均保留代码路径，测试中未拉起外部程序或真实命令）。
- 遗留风险：窄屏 390 顶栏按钮较多会换行；项目资料 1440 下按现有面板顺序纵向排列，信息密度高于参考图的演示数据；这些均不影响功能与验收。
