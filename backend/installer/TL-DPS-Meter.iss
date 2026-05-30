; Inno Setup script for ツCKヤ DPS Meter — per-user install (no admin/UAC).
; Built by build.py via ISCC; paths are relative to this file (backend/installer/).
; Per-user install to %LOCALAPPDATA%\Programs; the app keeps its writable state in
; %LOCALAPPDATA%\TL-DPS-Meter (see main.app_dir), so it never writes under a
; read-only install dir.

#define MyAppName "TL DPS Meter"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "StoopKid"
#define MyAppURL "https://github.com/stoopkid713/TL-DPS-Meter"
#define MyAppExeName "TL-DPS-Meter.exe"

[Setup]
; Stable AppId — keep constant across versions so upgrades/uninstall track correctly.
AppId={{7E9C2A14-3D5B-4F86-A1C7-9B0E2F4D6A88}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\TL-DPS-Meter
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=TL-DPS-Meter-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
// On uninstall, offer to also remove the per-user data folder
// (%LOCALAPPDATA%\TL-DPS-Meter: saved encounters, runs, settings, log).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\TL-DPS-Meter');
    if DirExists(DataDir) then
    begin
      if MsgBox('Also remove your saved data (encounters, runs, settings)?'#13#10#13#10
                + DataDir, mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
