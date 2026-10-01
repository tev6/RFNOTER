' RFNOTER - double-click launcher (no console window).
'
' NOTE: this file must stay pure ASCII. VBScript source is parsed with the system
' ANSI code page, so UTF-8 Chinese bytes here would swallow the closing quote of
' the string literals below and cause a "unterminated string constant" error.
Option Explicit

Dim shell, fso, root, exePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exePath) Then
    MsgBox "Electron runtime not found." & vbCrLf & vbCrLf & _
           "Run this once in the project folder:" & vbCrLf & _
           "    npm install" & vbCrLf & vbCrLf & _
           "If it still fails afterwards, run:" & vbCrLf & _
           "    node node_modules\electron\install.js", _
           48, "RFNOTER"
    WScript.Quit 1
End If

' Some environments (e.g. a child process started from another Electron app)
' inherit ELECTRON_RUN_AS_NODE, which makes electron.exe behave as plain Node
' and fail on main.js. Remove it - and only Remove it: assigning "" would
' recreate the variable, and Electron checks for its presence, not its value.
On Error Resume Next
shell.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

shell.CurrentDirectory = root
' Window style 1 = normal. Do NOT use 0 here: electron.exe is a GUI binary (no
' console to hide), and passing SW_HIDE makes the BrowserWindow inherit a hidden
' startup state, so the app would run with no visible window.
' False = do not wait for exit.
shell.Run """" & exePath & """ """ & root & """", 1, False
