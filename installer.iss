; Inno Setup script: builds Sceneseek-Setup.exe from the PyInstaller output.
; Build: ISCC.exe /DAppVersion=1.0.0 installer.iss
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6D0B6C1E-5E0A-4B7B-9C58-5CE9E5E5A1F1}
AppName=Sceneseek
AppVersion={#AppVersion}
AppPublisher=Galavix
AppPublisherURL=https://github.com/galavixofficial/Video-Search-Engine
DefaultDirName={autopf}\Sceneseek
DefaultGroupName=Sceneseek
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=build_out
OutputBaseFilename=Sceneseek-Setup
SetupIconFile=build_assets\sceneseek.ico
UninstallDisplayIcon={app}\Sceneseek.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "build_out\dist\Sceneseek\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Sceneseek"; Filename: "{app}\Sceneseek.exe"
Name: "{autodesktop}\Sceneseek"; Filename: "{app}\Sceneseek.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Sceneseek.exe"; Description: "Start Sceneseek"; Flags: nowait postinstall skipifsilent
