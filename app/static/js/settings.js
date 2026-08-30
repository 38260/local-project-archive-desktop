/* 设置弹窗（共享组件）：首页与项目详情页通用。
   通过 ref 调用 open() 打开；内部用页签分四区（通用/桌面/数据/危险区），免长滚动。
   设置变更后 emit("changed", kind, key)：
     kind="prefs"  偏好变化（父页面按需刷新联动状态，如编辑器按钮/主题/热力图范围）
     kind="data"   数据被导入/恢复/清空（父页面需整页重新加载） */
(function () {
  "use strict";

  window.LpaSettingsDialog = {
    name: "LpaSettingsDialog",
    props: {
      // 状态选项由父页面传入（首页来自列表接口，详情页来自详情接口）
      statuses: { type: Array, default: () => ["进行中", "已完成", "暂停", "归档", "废弃"] },
    },
    emits: ["changed"],
    data() {
      return {
        visible: false,   // 弹窗开关（不得叫 open：会与 open() 方法同名冲突，data 会遮蔽方法）
        tab: "general",   // general | desktop | data | danger
        prefs: {},        // 通用设置键值（来自 /api/settings）
        themeTick: 0,     // 主题按钮响应 window.themePref() 的开关
        editorOptions: [],
        autostart: { enabled: false, available: false, saving: false },
        importingBackup: false,
        backups: [],
        backupEnabled: true,
        backupKeep: 10,
        backupSaving: false,
        appVersion: "",
        appPort: "",
        dataPath: "",
      };
    },
    computed: {
      currentThemePref() {
        this.themeTick;   // 建立响应式依赖
        return window.themePref();
      },
    },
    methods: {
      open() {
        this.visible = true;
        // 每次打开都重新拉取：设置可能被另一个页面/上次会话改过
        this.loadPrefs();
        this.loadEditors();
        this.loadAutostart();
        this.loadBackups();
        api("/api/health", { silent: true }).then(h => {
          this.dataPath = h.data_path || "";
          this.appVersion = h.version || "";
          this.appPort = h.port || "";
        }).catch(() => {});
      },
      close() { this.visible = false; },
      switchTab(t) { this.tab = t; },

      // ---- 偏好（settings.json） ----
      async loadPrefs() {
        try {
          this.prefs = await api("/api/settings", { silent: true });
        } catch (e) { this.prefs = {}; }
      },
      async savePref(key) {
        try {
          await api("/api/settings", {
            method: "PUT", body: { [key]: this.prefs[key] ?? "" },
          });
          this.$emit("changed", "prefs", key, this.prefs[key]);
        } catch (e) { this.loadPrefs(); }   // 失败回滚显示
      },
      chooseTheme(v) {
        window.setThemePref(v);
        this.themeTick++;
        this.$emit("changed", "prefs", "theme");
      },
      // 编辑器下拉选项：后端探测 PATH 上可用的命令（带友好显示名）
      async loadEditors() {
        try {
          const r = await api("/api/settings/editors", { silent: true });
          this.editorOptions = (r.editors || []).map(e => ({ v: e.cmd, l: e.name }));
        } catch (e) {
          this.editorOptions = Object.keys(window.EDITOR_META);
        }
      },
      // 设置里选编辑器：父页面卡片/详情按钮的图标与文字经 changed 事件联动
      chooseEditor(cmd) {
        this.prefs["editor.command"] = cmd;
        this.savePref("editor.command");
      },

      // ---- 桌面行为 ----
      async loadAutostart() {
        try {
          const r = await api("/api/settings/autostart", { silent: true });
          this.autostart.enabled = !!r.enabled;
          this.autostart.available = !!r.available;
        } catch (e) {
          this.autostart.available = false;
        }
      },
      async toggleAutostart() {
        this.autostart.saving = true;
        const wanted = this.autostart.enabled;
        try {
          const r = await api("/api/settings/autostart", {
            method: "PUT", body: { enabled: wanted },
          });
          this.autostart.enabled = !!r.enabled;
          toast(r.enabled ? "已开启开机自启动" : "已关闭开机自启动", "ok");
        } catch (e) {
          this.autostart.enabled = !wanted;   // 失败回滚
        } finally {
          this.autostart.saving = false;
        }
      },

      // ---- 数据维护 ----
      exportJson() {
        toast("正在生成导出文件…", "ok");
        location.href = "/api/export";
      },
      async importBackup(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!file) return;
        let payload;
        try {
          payload = JSON.parse(await file.text());
        } catch (err) {
          toast("备份文件读取失败：不是有效的 JSON", "error");
          return;
        }
        if (!Array.isArray(payload.projects)) {
          toast("不是本系统导出的备份文件（缺少 projects 列表）", "error");
          return;
        }
        if (!await confirmDialog(
          `将导入 ${payload.projects.length} 个项目档案（已存在的路径会自动跳过）。继续吗？`,
          { title: "导入 JSON 备份", okText: "导入" })) return;
        this.importingBackup = true;
        try {
          const r = await api("/api/import", { method: "POST", body: payload });
          let msg = `导入 ${r.imported} 个项目，跳过 ${r.skipped} 个已存在`;
          if (r.failed.length) msg += `，${r.failed.length} 个失败`;
          toast(msg, r.failed.length ? "error" : "ok");
          this.$emit("changed", "data");
        } catch (err) { /* toast 已提示 */ }
        finally { this.importingBackup = false; }
      },
      async openDataFolder() {
        try {
          const r = await api("/api/settings/open-data-folder");
          toast("已打开数据文件夹", "ok");
          this.dataPath = r.path || this.dataPath;
        } catch (e) { /* toast 已提示 */ }
      },
      async openLog() {
        try {
          await api("/api/settings/open-log");
        } catch (e) { /* toast 已提示（开发模式无日志文件时会解释原因） */ }
      },

      // ---- 数据库备份 ----
      async loadBackups() {
        try {
          const r = await api("/api/settings/backups", { silent: true });
          this.backups = r.backups || [];
          this.backupEnabled = !!r.auto_enabled;
          this.backupKeep = r.keep || 10;
        } catch (e) { /* 静默 */ }
      },
      async saveBackupPrefs() {
        this.backupSaving = true;
        const keep = Math.min(99, Math.max(1, Number(this.backupKeep) || 10));
        try {
          await api("/api/settings", {
            method: "PUT",
            body: { "backup.enabled": !!this.backupEnabled, "backup.keep": keep },
          });
          this.backupKeep = keep;
        } catch (e) {
          this.loadBackups();   // 失败回滚显示
        } finally { this.backupSaving = false; }
      },
      async backupNow() {
        this.backupSaving = true;
        try {
          const r = await api("/api/settings/backups", { method: "POST" });
          toast(`已创建备份：${r.name}`, "ok");
          this.loadBackups();
        } catch (e) { /* toast 已提示 */ }
        finally { this.backupSaving = false; }
      },
      async restoreBackup(b) {
        if (!await confirmDialog(
          `用备份 ${b.name}（${fmtTime(b.mtime)}）覆盖当前档案数据？\n恢复前会先自动备份当前数据，误操作可再次恢复。`,
          { title: "从备份恢复", okText: "恢复" })) return;
        this.backupSaving = true;
        try {
          await api("/api/settings/backups/restore", { method: "POST", body: { name: b.name } });
          toast("已从备份恢复，正在刷新数据…", "ok");
          this.$emit("changed", "data");
          this.loadBackups();
        } catch (e) { /* toast 已提示 */ }
        finally { this.backupSaving = false; }
      },
      async deleteBackup(b) {
        if (!await confirmDialog(`删除备份 ${b.name}？删除后不可恢复。`,
          { title: "删除备份", okText: "删除", danger: true })) return;
        try {
          await api("/api/settings/backups", { method: "DELETE", body: { name: b.name } });
          toast("备份已删除", "ok");
          this.loadBackups();
        } catch (e) { /* toast 已提示 */ }
      },

      // ---- 危险区 ----
      async clearAll() {
        const v = await confirmDialog(
          "确定要清空全部档案数据吗？此操作不可撤销。\n建议先在「数据」页签里导出 JSON 备份。\n\n为防止误触，请输入 CLEAR 确认：",
          { title: "清空全部档案", okText: "确认清空", danger: true, requireText: "CLEAR" });
        if (v !== "CLEAR") return;
        try {
          const r = await api("/api/projects/all", { method: "DELETE" });
          toast(`已清空 ${r.deleted} 条档案记录`, "ok");
          this.$emit("changed", "data");
          this.close();
        } catch (e) { /* toast 已提示 */ }
      },
    },
    template: `
      <div class="modal-mask" v-if="visible" @click.self="close">
        <div class="modal" v-modal role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <h3 id="settings-title">设置</h3>
          <div class="settings-tabs" role="tablist" aria-label="设置分区">
            <button type="button" class="settings-tab" role="tab" :class="{ on: tab === 'general' }"
                    :aria-selected="tab === 'general' ? 'true' : 'false'" @click="switchTab('general')">
              <lpa-icon name="settings" :size="14"></lpa-icon>通用
            </button>
            <button type="button" class="settings-tab" role="tab" :class="{ on: tab === 'desktop' }"
                    :aria-selected="tab === 'desktop' ? 'true' : 'false'" @click="switchTab('desktop')">
              <lpa-icon name="monitor" :size="14"></lpa-icon>桌面
            </button>
            <button type="button" class="settings-tab" role="tab" :class="{ on: tab === 'data' }"
                    :aria-selected="tab === 'data' ? 'true' : 'false'" @click="switchTab('data')">
              <lpa-icon name="drive" :size="14"></lpa-icon>数据
            </button>
            <button type="button" class="settings-tab danger" role="tab" :class="{ on: tab === 'danger' }"
                    :aria-selected="tab === 'danger' ? 'true' : 'false'" @click="switchTab('danger')">
              <lpa-icon name="warning" :size="14"></lpa-icon>危险区
            </button>
          </div>

          <!-- 通用：主题 / 编辑器 / 使用偏好 -->
          <div v-show="tab === 'general'" role="tabpanel">
            <div class="field">
              <div class="setting-row">
                <div>
                  <span class="setting-title">主题外观</span>
                  <span class="setting-desc">顶栏切换按钮同样可用（三态轮转）</span>
                </div>
                <span class="setting-btns">
                  <button v-for="t in [{v:'auto',l:'跟随系统'},{v:'light',l:'亮色'},{v:'dark',l:'暗色'}]"
                          :key="t.v" class="btn sm"
                          :class="{ primary: currentThemePref === t.v }"
                          @click="chooseTheme(t.v)">{{ t.l }}</button>
                </span>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">打开项目的编辑器</span>
                  <span class="setting-desc">「{{ editorName(prefs['editor.command'] || 'code') }} 打开」按钮使用的编辑器，下拉里只列出本机可用的命令</span>
                </div>
                <lpa-select :model-value="prefs['editor.command'] || 'code'" :options="editorOptions"
                            @update:model-value="chooseEditor" aria-label="编辑器"></lpa-select>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">批量扫描默认深度</span>
                  <span class="setting-desc">打开扫描弹窗时的初始递归层数（1–6），扫描目录会自动记住上次的</span>
                </div>
                <input type="number" class="keep-input" min="1" max="6"
                       v-model.number="prefs['scan.default_depth']"
                       @change="savePref('scan.default_depth')" aria-label="默认扫描深度">
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">提交记录单次加载数</span>
                  <span class="setting-desc">详情页「提交记录」一次读取的条数上限，大仓库可调小以加快加载</span>
                </div>
                <lpa-select :model-value="String(prefs['commits.limit'] || 200)"
                            :options="[{v:'50',l:'50 条'},{v:'100',l:'100 条'},{v:'200',l:'200 条（最多）'}]"
                            @update:model-value="v => { prefs['commits.limit'] = Number(v); savePref('commits.limit'); }"></lpa-select>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">提交活动图范围</span>
                  <span class="setting-desc">详情页按月提交柱状图展示的时间跨度（半年=近 6 个月 / 一年=近 12 个月）</span>
                </div>
                <span class="setting-btns">
                  <button v-for="w in [{v:26,l:'半年'},{v:53,l:'一年'}]" :key="w.v" class="btn sm"
                          :class="{ primary: Number(prefs['ui.heatmap_weeks'] || 53) === w.v }"
                          @click="prefs['ui.heatmap_weeks'] = w.v; savePref('ui.heatmap_weeks');">{{ w.l }}</button>
                </span>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">启动时自动检查路径丢失</span>
                  <span class="setting-desc">服务启动后在后台校验各项目文件夹是否还在（只更新标记，不重新解析，不影响启动速度）</span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="prefs['scan.refresh_on_start']"
                         @change="savePref('scan.refresh_on_start')" aria-label="启动时自动检查路径丢失">
                  <span class="switch-slider"></span>
                </label>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">录入默认状态 / 分类</span>
                  <span class="setting-desc">手动录入与批量导入时的初始值，留空用系统默认（进行中 / 无分类）</span>
                </div>
                <span class="setting-btns">
                  <lpa-select :model-value="prefs['add.default_status'] || '进行中'"
                              :options="statuses"
                              @update:model-value="v => { prefs['add.default_status'] = v; savePref('add.default_status'); }"></lpa-select>
                  <input type="text" class="pref-input" v-model.trim="prefs['add.default_category']"
                         @change="savePref('add.default_category')" placeholder="默认分类" aria-label="默认分类">
                </span>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">默认显示废弃项目</span>
                  <span class="setting-desc">首页列表默认包含「废弃」状态的项目（归档项目始终展示，可随时用筛选栏关闭）</span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="prefs['ui.show_discarded_default']"
                         @change="savePref('ui.show_discarded_default')" aria-label="默认显示废弃项目">
                  <span class="switch-slider"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- 桌面：自启动 / 托盘 / 静默 -->
          <div v-show="tab === 'desktop'" role="tabpanel">
            <div class="field">
              <div class="setting-row">
                <div>
                  <span class="setting-title">登录 Windows 后自动启动</span>
                  <span class="setting-desc">数据仍在用户目录，不会因自启动多占端口</span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="autostart.enabled"
                         :disabled="!autostart.available || autostart.saving"
                         @change="toggleAutostart" aria-label="开机自启动">
                  <span class="switch-slider"></span>
                </label>
              </div>
              <div class="hint" v-if="!autostart.available">
                当前是开发模式（python 运行），开机自启动仅安装版（exe）可用。
              </div>
              <div class="hint" v-else-if="autostart.enabled">
                已开启：可在任务管理器「启动」标签中随时禁用。
              </div>
              <div class="hint" v-else>
                开启后，登录 Windows 会自动在后台启动本程序。
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">关闭时最小化到系统托盘</span>
                  <span class="setting-desc">点关闭按钮不退出程序，收进托盘；右键托盘图标可选「显示窗口」或「退出」（仅桌面窗口模式生效）</span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="prefs['tray.close_to_tray']"
                         @change="savePref('tray.close_to_tray')" aria-label="关闭时最小化到托盘">
                  <span class="switch-slider"></span>
                </label>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">启动时静默（不弹窗口）</span>
                  <span class="setting-desc">配合「开机自启动」与托盘使用：登录后只在托盘待命，需要时点托盘唤出</span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="prefs['app.start_minimized']"
                         :disabled="!prefs['tray.close_to_tray']"
                         @change="savePref('app.start_minimized')" aria-label="启动时静默">
                  <span class="switch-slider"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- 数据：导入导出 / 数据位置 / 数据库备份 -->
          <div v-show="tab === 'data'" role="tabpanel">
            <div class="field">
              <div class="setting-row">
                <div>
                  <span class="setting-title">备份与恢复</span>
                  <span class="setting-desc">导出全部档案为 JSON（含笔记与变更日志）；导入时已存在的路径自动跳过</span>
                </div>
                <span class="setting-btns">
                  <button class="btn sm" @click="exportJson" title="导出全部档案为 JSON 备份">
                    <lpa-icon name="download" :size="13"></lpa-icon>导出
                  </button>
                  <label class="btn sm" style="cursor:pointer" title="从备份文件恢复档案">
                    <lpa-icon name="upload" :size="13"></lpa-icon>{{ importingBackup ? "导入中…" : "导入" }}
                    <input type="file" accept=".json,application/json" style="display:none"
                           @change="importBackup" :disabled="importingBackup">
                  </label>
                </span>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">导出 HTML 包含笔记与日志</span>
                  <span class="setting-desc">关闭后「导出 HTML 报告」只含项目档案信息，不含开发笔记与变更日志</span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="prefs['export.html_include_notes']"
                         @change="savePref('export.html_include_notes')" aria-label="导出 HTML 包含笔记与日志">
                  <span class="switch-slider"></span>
                </label>
              </div>
              <div class="setting-row" style="margin-top:10px">
                <div>
                  <span class="setting-title">数据位置</span>
                  <span class="setting-desc">数据库、备份、截图、设置文件统一存放的目录</span>
                </div>
                <span class="setting-btns">
                  <button class="btn sm" @click="openDataFolder" title="在资源管理器中打开数据目录">
                    <lpa-icon name="folder-open" :size="13"></lpa-icon>打开数据文件夹
                  </button>
                  <button class="btn sm" @click="openLog" title="打开应用日志文件">
                    <lpa-icon name="file-text" :size="13"></lpa-icon>查看日志
                  </button>
                </span>
              </div>
            </div>
            <div class="field">
              <div class="setting-row">
                <div>
                  <span class="setting-title">启动时自动备份数据库</span>
                  <span class="setting-desc">
                    保留最近
                    <input type="number" class="keep-input" min="1" max="99" v-model.number="backupKeep"
                           @change="saveBackupPrefs" :disabled="backupSaving" aria-label="保留份数">
                    份（存于 data/backups/）
                  </span>
                </div>
                <label class="switch">
                  <input type="checkbox" v-model="backupEnabled" @change="saveBackupPrefs"
                         :disabled="backupSaving" aria-label="启动时自动备份">
                  <span class="switch-slider"></span>
                </label>
              </div>
              <div class="backup-list" v-if="backups.length">
                <div class="backup-item" v-for="b in backups" :key="b.name">
                  <span class="mono backup-name">{{ b.name }}</span>
                  <span class="section-note">{{ fmtSize(b.size) }} · {{ fmtTime(b.mtime) }}</span>
                  <span class="fill"></span>
                  <button class="btn sm" @click="restoreBackup(b)">恢复</button>
                  <button class="icon-btn" title="删除该备份" aria-label="删除该备份" @click="deleteBackup(b)">
                    <lpa-icon name="trash" :size="13"></lpa-icon>
                  </button>
                </div>
              </div>
              <div class="hint" v-else>暂无备份（启动服务时自动创建，或点下方按钮立即备份）</div>
              <div style="margin-top:8px">
                <button class="btn sm" @click="backupNow" :disabled="backupSaving">
                  <lpa-icon name="save" :size="13"></lpa-icon>{{ backupSaving ? "备份中…" : "立即备份" }}
                </button>
              </div>
            </div>
          </div>

          <!-- 危险区 -->
          <div v-show="tab === 'danger'" role="tabpanel">
            <div class="field danger-zone">
              <div class="setting-row">
                <div>
                  <span class="setting-title">清空全部档案</span>
                  <span class="setting-desc">删除所有项目记录、笔记、变更日志与截图（不触碰原项目文件）。建议先在「数据」页签导出 JSON 备份。</span>
                </div>
                <button class="btn sm danger" @click="clearAll">
                  <lpa-icon name="trash" :size="13"></lpa-icon>清空
                </button>
              </div>
            </div>
          </div>

          <div class="app-info">
            归迹拾光 <b>v{{ appVersion }}</b> · 服务端口 <b>{{ appPort }}</b> ·
            数据：<span class="mono">{{ dataPath }}</span>
          </div>
          <div class="actions">
            <button class="btn primary" @click="close">完成</button>
          </div>
        </div>
      </div>
    `,
  };
})();
