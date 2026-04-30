@echo off
setlocal

rem =====================================================================
rem AMLL Player - Android debug build + install one-shot script
rem Tested on Windows 10 / cmd.exe with:
rem   JDK 17 (Temurin), Android SDK + NDK 29.x, Gradle 8.13 (local),
rem   Android FFmpeg arm64 prebuilt, MIUI / Xiaomi 23078RKD5C device.
rem =====================================================================

rem ---- toolchain paths (edit here if locations change) ----
set "JAVA_HOME=C:\Users\Administrator\AppData\Local\Programs\Eclipse Adoptium\jdk-17.0.18.8-hotspot"
set "ANDROID_HOME=C:\Users\Administrator\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "ANDROID_NDK_HOME=%ANDROID_HOME%\ndk\29.0.13846066"
set "ANDROID_NDK_ROOT=%ANDROID_NDK_HOME%"
set "CARGO_NDK_SYSROOT_PATH=%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\sysroot"
set "GRADLE_HOME=D:\tools\gradle-8.13"

rem ---- target-specific FFmpeg (Android arm64) ----
set "FFMPEG_DIR=D:\a\applemusic-like-lyrics\applemusic-like-lyrics\vendor\ffmpeg-8.0.1-android-arm64-v8a"
set "FFMPEG_DIR_AARCH64_LINUX_ANDROID=%FFMPEG_DIR%"
set "PKG_CONFIG_PATH=%FFMPEG_DIR%\lib\pkgconfig"

set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\cmdline-tools\latest\bin;%GRADLE_HOME%\bin;%PATH%"

rem ---- project paths ----
set "PROJECT_DIR=D:\a\amll-player\packages\player"
set "APK_PATH=%PROJECT_DIR%\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
set "PACKAGE_ID=net.stevexmh.amllplayer"
set "DEVICE_SERIAL=AMNZZXYDIVW4HEQW"

echo ===== Environment =====
echo JAVA_HOME=%JAVA_HOME%
echo ANDROID_HOME=%ANDROID_HOME%
echo ANDROID_NDK_HOME=%ANDROID_NDK_HOME%
echo FFMPEG_DIR=%FFMPEG_DIR%
echo PROJECT_DIR=%PROJECT_DIR%
echo DEVICE_SERIAL=%DEVICE_SERIAL%
echo.

rem ---- sanity checks ----
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo [FAIL] JDK not found at %JAVA_HOME%
  exit /b 1
)
if not exist "%ANDROID_NDK_HOME%" (
  echo [FAIL] NDK not found at %ANDROID_NDK_HOME%
  exit /b 1
)
if not exist "%FFMPEG_DIR%\lib\libavcodec.a" (
  echo [FAIL] Android FFmpeg libavcodec.a not found in %FFMPEG_DIR%\lib
  exit /b 1
)
if not exist "%GRADLE_HOME%\bin\gradle.bat" (
  echo [WARN] Local Gradle not found at %GRADLE_HOME% - wrapper will be used
)

rem ---- check device ----
echo ===== adb devices =====
adb devices
echo.

rem ---- build APK ----
echo ===== Building debug APK (aarch64) =====
cd /d "%PROJECT_DIR%" || (echo cd failed & exit /b 1)
call pnpm tauri android build --debug --apk --target aarch64
if errorlevel 1 (
  echo [FAIL] tauri android build failed
  exit /b 1
)

if not exist "%APK_PATH%" (
  echo [FAIL] APK not found at %APK_PATH%
  exit /b 1
)
echo APK: %APK_PATH%
echo.

rem ---- install ----
echo ===== Installing to device %DEVICE_SERIAL% =====
adb -s %DEVICE_SERIAL% install -r "%APK_PATH%"
if errorlevel 1 (
  echo [WARN] install -r failed, trying uninstall + install ...
  adb -s %DEVICE_SERIAL% uninstall %PACKAGE_ID%
  adb -s %DEVICE_SERIAL% install "%APK_PATH%"
  if errorlevel 1 (
    echo [FAIL] install failed. Possible causes:
    echo   - MIUI: enable "Install via USB" in developer options
    echo   - device offline / not authorized
    echo   - install dialog on phone needs manual confirm
    exit /b 1
  )
)

rem ---- launch ----
echo ===== Launching %PACKAGE_ID% on %DEVICE_SERIAL% =====
adb -s %DEVICE_SERIAL% shell monkey -p %PACKAGE_ID% -c android.intent.category.LAUNCHER 1

echo.
echo ===== DONE =====
endlocal
