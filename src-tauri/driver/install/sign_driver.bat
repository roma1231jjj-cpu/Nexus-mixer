@echo off
set SIGNTOOL="C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
set SYSFILE="E:\nexus-mixer\src-tauri\driver\build\x64\Release\nexusvaio.sys"

echo === Signing driver ===
%SIGNTOOL% sign /v /fd sha256 /s MY /n "NexusVAIO Test Certificate" %SYSFILE%
if %ERRORLEVEL% neq 0 (
    echo Signing FAILED! Exit code: %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)
echo === Verification ===
%SIGNTOOL% verify /v /a %SYSFILE% 2>nul || echo (verify warning ignored - normal for self-signed cert)
echo DONE