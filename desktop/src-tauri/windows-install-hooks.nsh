; Keep the application payload at the current-user path that Launcher verifies.
; A different selection must abort before any application files are copied.
!macro NSIS_HOOK_PREINSTALL
  ${If} $INSTDIR != "$LOCALAPPDATA\${PRODUCTNAME}"
    MessageBox MB_OK|MB_ICONSTOP "Install ${PRODUCTNAME} in $LOCALAPPDATA\${PRODUCTNAME}. Custom application folders are not supported."
    Abort
  ${EndIf}
!macroend
