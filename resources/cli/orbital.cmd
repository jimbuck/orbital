@echo off
setlocal
rem Run the bundled CLI on the app's own Electron binary as plain Node
rem (ELECTRON_RUN_AS_NODE): a packaged install has no guarantee of a system
rem `node`, and the Claude hooks call this shim by absolute path from every
rem session. From a source checkout (resources\cli\..\..) there is no
rem Orbital.exe, so fall back to node from PATH.
if exist "%~dp0..\..\Orbital.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%~dp0..\..\Orbital.exe" "%~dp0orbital.js" %*
) else (
  node "%~dp0orbital.js" %*
)
