; Lumen keeps its data in LumenData\ next to Lumen.exe (settings, the EmuStart game cache,
; emulators, BIOS files, saves). electron-builder's uninstaller removes the whole install folder,
; also when updating — this replaces that step: program files go, LumenData stays.

!macro customRemoveFiles
  SetOutPath $TEMP
  FindFirst $R1 $R2 "$INSTDIR\*.*"
  lumen_rm_loop:
    StrCmp $R2 "" lumen_rm_done
    StrCmp $R2 "." lumen_rm_next
    StrCmp $R2 ".." lumen_rm_next
    StrCmp $R2 "LumenData" lumen_rm_next
    IfFileExists "$INSTDIR\$R2\*.*" 0 lumen_rm_file
      RMDir /r "$INSTDIR\$R2"
      Goto lumen_rm_next
    lumen_rm_file:
      Delete "$INSTDIR\$R2"
    lumen_rm_next:
      FindNext $R1 $R2
      Goto lumen_rm_loop
  lumen_rm_done:
  FindClose $R1
  ; removes the folder only when nothing is left (no LumenData)
  RMDir $INSTDIR
!macroend
