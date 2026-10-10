; ---------------------------------------------------------------------------
; Tracelight（归迹拾光）Inno Setup 安装脚本
;
; 用法（先装 Inno Setup 6：winget install --id JRSoftware.InnoSetup -e）：
;   iscc installer\tracelight.iss
; 或直接跑一键脚本：tools\build_installer.bat
;
; 设计要点：
;   -  per-user 安装（PrivilegesRequired=lowest）：不弹 UAC、可装无管理员权限的机器，
;      也避开 Program Files 的写权限问题（数据本来就在 %LOCALAPPDATA%，与安装目录无关）；
;   - 卸载默认保留用户数据；卸载向导里可选「同时删除用户数据」；
;   - 覆盖安装：自动 taskkill 掉正在运行的旧程序（含从 dist 直接跑的绿色版），
;      再清掉旧的 _internal 后替换成新版本文件，全程无需用户手动关闭；
;   - 开始菜单快捷方式必有，桌面快捷方式可选（默认不建，减少打扰）。
; ---------------------------------------------------------------------------

#define MyAppName        "Tracelight"
#define MyAppDisplayName "归迹拾光"
#define MyAppVersion     "1.10.0"
#define MyAppPublisher   "BJTU-Yibo"
#define MyAppExeName     "Tracelight.exe"
; 固定 GUID：升级安装靠它识别「同一个应用」，不要改
#define MyAppId          "{{B7E2F1A4-9C3D-4E6F-8A2B-5D4C3B2A1900}"
; 任务栏归组标识：必须与 desktop.py 里 SetCurrentProcessExplicitAppUserModelID 的
; 取值逐字一致，否则固定到任务栏的图标会被 Windows 当成另一个应用
#define MyAppAUMID       "GuijiShiguang.Tracelight"

[Setup]
AppId={#MyAppId}
AppName={#MyAppDisplayName} ({#MyAppName})
AppVersion={#MyAppVersion}
VersionInfoVersion={#MyAppVersion}.0
AppPublisher={#MyAppPublisher}
; per-user 默认安装目录：C:\Users\<用户>\AppData\Local\Programs\Tracelight
DefaultDirName={localappdata}\Programs\{#MyAppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=Tracelight-Setup-{#MyAppVersion}
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppDisplayName} ({#MyAppName})
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; 关掉正在运行的旧程序这件事，交给 [Code] 里的 KillRunningApp 全权负责，
; 不用 Inno 默认的 Restart Manager（CloseApplications=yes）：它只会给主窗口发
; WM_CLOSE，而本应用开着「关闭时最小化到托盘」时会拦下这条消息（见 desktop.py 的
; _on_closing 返回 False 取消关闭），于是必然卡在「无法关闭，请手动关闭」的死路。
; 置 no 之后不再弹「是否自动关闭这些程序」的询问框，也不会出现关不掉的僵局。
CloseApplications=no
; 安装器界面语言：默认英文；想要中文界面时，下载 ChineseSimplified.isl
; （Inno Setup 官网 Translations 页）放到 Inno 的 Languages 目录，
; 然后把下面一行改成：english,chineseSimplified
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional options:"; Flags: unchecked

[Files]
; onedir 全量打包：exe + _internal（递归）
Source: "..\dist\Tracelight\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; 覆盖安装前先清空运行时目录，让「直接替换成新版本文件」是干净的：
; PyInstaller onedir 的 _internal 里一旦混进旧版本的 dll/pyd（Python 或依赖版本
; 一变就容易出问题），会出现启动即崩、找不到模块这类很难查的故障。
; 由 Setup 卸载旧版时通常已经删过一遍，这里是兜底——例如把 dist 目录手动复制到
; 安装目录（没有卸载记录）之后再做覆盖安装的情况。
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
; AppUserModelID 不可省：少了它，固定到任务栏的图标与运行中的窗口会被 Windows
; 视为两个应用（出现两个任务栏按钮，点图标只会再拉起一个进程），
; 加上后点图标才是「唤出已有窗口」，与托盘图标行为一致。
Name: "{autoprograms}\{#MyAppDisplayName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppAUMID}"
Name: "{autodesktop}\{#MyAppDisplayName}";  Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; AppUserModelID: "{#MyAppAUMID}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录残留下属正常清理；用户数据在 %LOCALAPPDATA%\Tracelight，默认不动

[Code]
// ---------------------------------------------------------------------------
// 覆盖安装：自动关掉正在运行的旧程序，再替换成新版本文件
//
// 本应用是托盘常驻程序，并且默认开启「关闭时最小化到托盘」——收到 WM_CLOSE 只会
// 隐藏窗口（desktop.py 的 _on_closing 返回 False 取消关闭）。所以 Inno 自带的
// Restart Manager（CloseApplications）对它无效，必须用 taskkill 强制结束。
//
// 「是否还在运行」用应用自己创建的命名互斥体来判断：进程一退出系统立即释放，
// 既不受 PID 复用影响，也能用来等它真正退出、把文件句柄放干净。
// ---------------------------------------------------------------------------
const
  // 与 desktop.py 的 MUTEX_NAME 必须逐字一致
  AppMutexName = 'Tracelight_SingleInstanceMutex';

// 结束正在运行的旧程序，并等到它真正退出、文件句柄释放。
procedure KillRunningApp();
var
  ResultCode, I: Integer;
begin
  // 不做「先判断再杀」：没在跑时 taskkill 只报「找不到进程」，没有副作用；
  // 反倒是「检测不到却仍在运行」才会留下文件被占用的坑。
  // /F 强制结束；/T 连带子进程（pywebview 的 WebView2 渲染进程）。
  // 按镜像名匹配，所以从 dist 目录直接运行的绿色版同样会被关掉。
  Exec('taskkill', '/F /T /IM {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 进程退出后内核对象与文件映射的释放有延迟，轮询等互斥体消失（最多 10 秒）
  for I := 1 to 40 do
  begin
    if not CheckForMutexes(AppMutexName) then
      Break;
    Sleep(250);
  end;
  Sleep(500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  // 时机：本函数在 Setup 检查「文件是否被占用」之前、旧版本被卸载之前调用，
  // 是关掉旧程序最合适的位置——关完之后，卸载旧版与复制新文件都不会再撞占用。
  KillRunningApp();
  if CheckForMutexes(AppMutexName) then
  begin
    // 自动关不掉（多半是旧进程以管理员身份启动，权限不同）：明确报错并允许重试，
    // 好过让安装走到一半才因为文件被占用而失败。
    Result := '检测到旧版本程序仍在运行，且无法自动关闭。' + #13#10#13#10
      + '请手动退出后点「重试」：' + #13#10
      + '· 右键系统托盘图标选择「退出」；' + #13#10
      + '· 或按 Ctrl+Shift+Esc 打开任务管理器，结束 {#MyAppExeName}'
      + '（若是以源码 python desktop.py 运行的，请结束对应的 python 进程）。';
    Exit;
  end;
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  // 卸载一开始就关掉程序，否则 {app} 下的文件被占用、删不掉
  KillRunningApp();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  // 卸载完成后询问是否删除用户数据（默认保留）
  if CurUninstallStep = usPostUninstall then
  begin
    // 覆盖安装时，Setup 会在后台静默调用旧版的卸载程序，这一步绝不能打扰用户。
    // 必须主动判断静默状态：Inno 调用旧卸载程序时未必带 /SUPPRESSMSGBOXES，
    // 光把 MsgBox 换成 SuppressibleMsgBox 仍有可能弹出对话框、把升级流程卡住。
    if UninstallSilent then
      Exit;
    DataDir := GetEnv('LOCALAPPDATA') + '\{#MyAppName}';
    if DirExists(DataDir) then
    begin
      if SuppressibleMsgBox('Uninstall has finished. Your archive data (projects, backups, screenshots) is still kept in:' #13#10
        + DataDir + #13#10#13#10
        + 'Delete this data as well? (Choose "No" to keep it, and it will be reused when you reinstall.)',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;
