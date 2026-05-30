; Inno Setup script for ツCKヤ DPS Meter — per-user install (no admin/UAC).
; Built by build.py via ISCC; paths are relative to this file (backend/installer/).
; Per-user install to %LOCALAPPDATA%\Programs; the app keeps its writable state in
; %LOCALAPPDATA%\TL-DPS-Meter (see main.app_dir), so it never writes under a
; read-only install dir.

#define MyAppName "TL DPS Meter"
#define MyAppVersion "1.0.1"
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
// --- Maintenance: when already installed, re-running Setup offers repair/remove ---
// Inno doesn't have an MSI-style maintenance mode; without this, re-launching the
// installer just walks the install wizard again. Detect a prior install (the _is1
// uninstall key for our AppId, per-user HKCU or elevated HKLM) and offer the user
// a clear choice up front: reinstall/repair, uninstall, or cancel.
const
  UNINST_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7E9C2A14-3D5B-4F86-A1C7-9B0E2F4D6A88}_is1';

function GetUninstallString(): String;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, UNINST_KEY, 'UninstallString', Result) then
    RegQueryStringValue(HKLM, UNINST_KEY, 'UninstallString', Result);
end;

// silent=True for repair (remove old copy quietly, KEEP user data, then reinstall);
// silent=False for a real uninstall so the interactive uninstaller runs and its
// "keep or delete your saved data?" prompt (CurUninstallStepChanged, guarded by
// not UninstallSilent) actually fires.
function RunExistingUninstaller(silent: Boolean): Boolean;
var
  s, params: String;
  show, code: Integer;
begin
  s := RemoveQuotes(GetUninstallString());
  if silent then begin
    params := '/SILENT /NORESTART /SUPPRESSMSGBOXES';
    show := SW_HIDE;
  end else begin
    params := '/NORESTART';        // interactive: shows the uninstall UI + data prompt
    show := SW_SHOWNORMAL;
  end;
  Result := (s <> '') and Exec(s, params, '', show, ewWaitUntilTerminated, code);
end;

function InitializeSetup(): Boolean;
var
  choice: Integer;
begin
  Result := True;
  if GetUninstallString() <> '' then
  begin
    choice := MsgBox(
      'TL DPS Meter is already installed. What would you like to do?' + #13#10#13#10 +
      'Yes' + #9 + '— Reinstall / repair (keeps your saved data)' + #13#10 +
      'No' + #9 + '— Uninstall it and exit' + #13#10 +
      'Cancel' + #9 + '— Do nothing',
      mbConfirmation, MB_YESNOCANCEL);
    case choice of
      IDYES: RunExistingUninstaller(True);        // quiet remove, keep data, then repair
      IDNO:  begin
               RunExistingUninstaller(False);     // interactive uninstall (prompts re: data)
               Result := False;                   // then exit Setup
             end;
    else
      Result := False;                            // cancel: leave everything as-is
    end;
  end;
end;

// On uninstall, offer to also remove the per-user data folder
// (%LOCALAPPDATA%\TL-DPS-Meter: saved encounters, runs, settings, log).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  // Only prompt during an interactive uninstall. A silent uninstall (/VERYSILENT)
  // must NOT show a MsgBox — it would block forever waiting for a click — so it
  // leaves user data in place (the safe default).
  if (CurUninstallStep = usUninstall) and (not UninstallSilent) then
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
