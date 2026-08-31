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
;   - 安装/卸载前自动 taskkill 正在运行的程序，避免文件占用；
;   - 开始菜单快捷方式必有，桌面快捷方式可选（默认不建，减少打扰）。
; ---------------------------------------------------------------------------

#define MyAppName        "Tracelight"
#define MyAppDisplayName "归迹拾光"
#define MyAppVersion     "1.1.0"
#define MyAppPublisher   "Tracelight"
#define MyAppExeName     "Tracelight.exe"
; 固定 GUID：升级安装靠它识别「同一个应用」，不要改
#define MyAppId          "{{B7E2F1A4-9C3D-4E6F-8A2B-5D4C3B2A1900}"

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

[Icons]
Name: "{autoprograms}\{#MyAppDisplayName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppDisplayName}";  Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录残留下属正常清理；用户数据在 %LOCALAPPDATA%\Tracelight，默认不动

[Code]
// 安装/卸载前关掉正在运行的程序，避免文件被占用
procedure KillRunningApp();
var
  ResultCode: Integer;
begin
  Exec('taskkill', '/IM {#MyAppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillRunningApp();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
    KillRunningApp();
  // 卸载完成后询问是否删除用户数据（默认保留）
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := GetEnv('LOCALAPPDATA') + '\{#MyAppName}';
    if DirExists(DataDir) then
    begin
      if MsgBox('Uninstall has finished. Your archive data (projects, backups, screenshots) is still kept in:' #13#10
        + DataDir + #13#10#13#10
        + 'Delete this data as well? (Choose "No" to keep it, and it will be reused when you reinstall.)',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;
