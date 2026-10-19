; Moves per-user installs from the folder named under the old product ("synthv-toolbox", which electron-builder derives
; from the unchanged package name) to "Toneshuttle". Names must match FILE_NAMES and LEGACY_FILE_NAMES in electron/brand.ts.
;
; Only installer-side hooks are used: the uninstaller that runs during this upgrade is the old build's stock one, so
; un.* hooks added here would only take effect from the next upgrade on.
!define LEGACY_INSTALL_DIRECTORY "synthv-toolbox"
!define LEGACY_EXECUTABLE "Synthesizer V Toolbox.exe"
!define LEGACY_SHORTCUT "Synthesizer V Toolbox"
!define INSTALL_DIRECTORY "Toneshuttle"

!ifndef BUILD_UNINSTALLER
Var legacyInstallDir

; Sets $R3 to 0 when the old executable is running for the current user. The stock running-app check looks for the new
; executable in the new folder and so cannot see it.
!macro FIND_LEGACY_APP
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${LEGACY_EXECUTABLE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${LEGACY_EXECUTABLE}\""`
  Pop $R3
!macroend

; Runs after initMultiUser has set $INSTDIR from the registry (upgrades) or the default (fresh installs). Only the
; variable changes: the registry InstallLocation keeps naming the old folder until registryAddInstallInfo, so the old
; uninstaller, which uninstallOldVersion runs with _?=<registry InstallLocation>, still removes the old folder. Writing
; InstallLocation here instead would make it clean the new, empty folder and orphan a runnable old copy.
!macro customInit
  StrCpy $legacyInstallDir ""
  ; An explicit /D= is the user's choice of folder and is kept as given.
  !insertmacro GetDParameter $R0
  ${if} $R0 == ""
    ${GetFileName} "$INSTDIR" $R1
    ${if} $R1 == "${LEGACY_INSTALL_DIRECTORY}"
      ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $R2 != ""
        StrCpy $legacyInstallDir "$INSTDIR"
      ${endif}
      ${GetParent} "$INSTDIR" $R1
      StrCpy $INSTDIR "$R1\${INSTALL_DIRECTORY}"
    ${endif}
  ${endif}
  ; The old uninstaller closes a running old app without asking, because the installer always passes it --updated.
  ; A manual upgrade asked first before the rename, so ask here; in-app updates have already quit the old app.
  ${if} $legacyInstallDir != ""
  ${AndIfNot} ${isUpdated}
    !insertmacro FIND_LEGACY_APP
    ${if} $R3 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
    ${endif}
  ${endif}
!macroend

; Runs after the new files, registry entries and shortcuts exist. Normally the old uninstaller has already removed the
; old folder; this covers the case where it could not be launched, which would leave a runnable old copy behind. A copy
; that is still running is left alone rather than half deleted.
!macro customInstall
  ${if} $legacyInstallDir != ""
  ${andIf} $legacyInstallDir != $INSTDIR
  ${andIf} ${FileExists} "$legacyInstallDir\*.*"
    !insertmacro FIND_LEGACY_APP
    ${if} $R3 == 0
      DetailPrint "${LEGACY_EXECUTABLE} is still running; keeping $legacyInstallDir."
    ${else}
      !if "${LEGACY_SHORTCUT}" != "${SHORTCUT_NAME}"
        ${if} ${FileExists} "$legacyInstallDir\${LEGACY_EXECUTABLE}"
          Delete "$DESKTOP\${LEGACY_SHORTCUT}.lnk"
          Delete "$SMPROGRAMS\${LEGACY_SHORTCUT}.lnk"
        ${endif}
      !endif
      RMDir /r "$legacyInstallDir"
    ${endif}
  ${endif}
!macroend
!endif
