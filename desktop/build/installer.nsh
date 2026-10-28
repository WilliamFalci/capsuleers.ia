; Custom NSIS uninstall hook for Capsuleers.IA.
;
; A default electron-builder uninstall removes the installed program files but leaves
; ALL per-user data behind: the downloaded .gguf models (~1 GB+), the RAG index,
; the Electron caches and the app settings, under %APPDATA%\capsuleers-ia-desktop.
; By product decision the uninstall must reclaim every byte, unconditionally.
;
; Notes:
;  - perMachine is false (assisted, per-user install), so the uninstaller runs as the
;    user who installed it -> $APPDATA / $LOCALAPPDATA resolve to that user's profile,
;    the same one that ran the app and downloaded the models.
;  - nsis.deleteAppDataOnUninstall is "one-click installer only"; our installer is
;    assisted (oneClick: false), so this customUnInstall macro is the supported way.
;  - electron-builder auto-includes build/installer.nsh (the default `nsis.include`),
;    so no config change is needed.
;  - electron-builder runs the PREVIOUS uninstaller during every update (silent, with
;    --updated). Without the ${isUpdated} guard each auto-update would wipe the user
;    data too, so the RMDir calls only run on a real uninstall.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; userData: downloaded models + RAG index + Electron caches + settings.
    RMDir /r "$APPDATA\capsuleers-ia-desktop"
    ; electron-updater download cache (updaterCacheDirName = capsuleers-ia-desktop-updater).
    RMDir /r "$LOCALAPPDATA\capsuleers-ia-desktop-updater"
  ${endIf}
!macroend
