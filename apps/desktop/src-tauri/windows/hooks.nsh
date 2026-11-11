; Silent uninstall skips the "delete app data" checkbox, which would
; otherwise leave the per-user install-location key and the WebView folder.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\${MANUFACTURER}\${PRODUCTNAME}"
  DeleteRegKey /ifempty HKCU "Software\${MANUFACTURER}"
  RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
  RMDir /r "$APPDATA\${BUNDLEID}"
!macroend
