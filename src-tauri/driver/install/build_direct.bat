@echo off
setlocal enabledelayedexpansion

set VSROOT=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
set MSVC=%VSROOT%\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64
set WDK_INC=C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0
set WDK_LIB=C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\km\x64
set VC_INC=%VSROOT%\VC\Tools\MSVC\14.44.35207\include
set SRC=E:\nexus-mixer\src-tauri\driver
set OUT=%SRC%\build\x64\Release
set OBJ=%OUT%\obj

mkdir "%OBJ%" 2>nul

echo === Compiling driver.cpp ===
"%MSVC%\cl.exe" /nologo /c /kernel /W3 /WX- /O2 /std:c++14 ^
    /Fo:"%OBJ%\driver.obj" ^
    /I"%SRC%" ^
    /I"%WDK_INC%\km" ^
    /I"%WDK_INC%\km\crt" ^
    /I"%WDK_INC%\shared" ^
    /I"%VC_INC%" ^
    /D"_WIN32_WINNT=0x0A00" /D"WINVER=0x0A00" /D"NTDDI_VERSION=0x0A000000" ^
    /D"NDEBUG" /D"_AMD64_" /D"DBG=0" ^
    "%SRC%\nexusvaio\driver.cpp"
echo CL exit code: %ERRORLEVEL%

if not exist "%OBJ%\driver.obj" (
    echo FAILED: driver.obj not found
    exit /b 1
)

echo === Compiling resources ===
set RC=C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe
"%RC%" /nologo /fo"%OBJ%\nexusvaio.res" /I"%WDK_INC%\um" /I"%WDK_INC%\shared" "%SRC%\nexusvaio\nexusvaio.rc"
echo RC exit code: %ERRORLEVEL%

echo === Linking ===
"%MSVC%\link.exe" /NOLOGO /NODEFAULTLIB /KERNEL ^
    /SECTION:INIT,d /SECTION:.idata,R ^
    /IGNORE:4001,4078,4087,4089,4096,4098,4099,4108,4210 ^
    /OUT:"%OUT%\nexusvaio.sys" ^
    /ENTRY:DriverEntry /SUBSYSTEM:NATIVE /DRIVER /RELEASE ^
    "%OBJ%\driver.obj" "%OBJ%\nexusvaio.res" ^
    /LIBPATH:"%WDK_LIB%" portcls.lib ks.lib wdmsec.lib ntoskrnl.lib stdunk.lib hal.lib wmilib.lib ksguid.lib
echo LINK exit code: %ERRORLEVEL%

if exist "%OUT%\nexusvaio.sys" (
    echo SUCCESS! Driver created: %OUT%\nexusvaio.sys
    dir /b "%OUT%\nexusvaio.sys"
) else (
    echo FAILED: nexusvaio.sys not created
    exit /b 1
)