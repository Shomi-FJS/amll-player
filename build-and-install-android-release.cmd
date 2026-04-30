@echo off
setlocal enabledelayedexpansion
set "ORIGINAL_PATH=%PATH%"

:run_script
set "RUN_EXIT_CODE=0"

rem =====================================================================
rem AMLL Player - Android RELEASE build + sign (debug key) + install
rem Same env as build-and-install-android.cmd, but produces release APK,
rem signs it with ~/.android/debug.keystore, then installs to device.
rem Use this to verify R8/ProGuard behavior (e.g. SAF picker crash).
rem =====================================================================

set "JAVA_HOME=C:\Users\Administrator\AppData\Local\Programs\Eclipse Adoptium\jdk-17.0.18.8-hotspot"
set "ANDROID_HOME=C:\Users\Administrator\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "ANDROID_NDK_HOME=%ANDROID_HOME%\ndk\29.0.13846066"
set "ANDROID_NDK_ROOT=%ANDROID_NDK_HOME%"
set "CARGO_NDK_SYSROOT_PATH=%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\sysroot"
set "GRADLE_HOME=D:\tools\gradle-8.13"

set "FFMPEG_DIR=D:\a\applemusic-like-lyrics\applemusic-like-lyrics\vendor\ffmpeg-8.0.1-android-arm64-v8a"
set "FFMPEG_DIR_AARCH64_LINUX_ANDROID=%FFMPEG_DIR%"
set "PKG_CONFIG_PATH=%FFMPEG_DIR%\lib\pkgconfig"

set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\cmdline-tools\latest\bin;%GRADLE_HOME%\bin;%ORIGINAL_PATH%"

rem ---- pick latest build-tools dir (for apksigner / zipalign) ----
set "BUILD_TOOLS_DIR="
for /f "delims=" %%i in ('dir /b /ad /o-n "%ANDROID_HOME%\build-tools" 2^>nul') do (
  if not defined BUILD_TOOLS_DIR set "BUILD_TOOLS_DIR=%ANDROID_HOME%\build-tools\%%i"
)
if not defined BUILD_TOOLS_DIR (
  echo [FAIL] No build-tools found under %ANDROID_HOME%\build-tools
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
set "APKSIGNER=%BUILD_TOOLS_DIR%\apksigner.bat"
set "ZIPALIGN=%BUILD_TOOLS_DIR%\zipalign.exe"

set "PROJECT_DIR=D:\a\amll-player\packages\player"
set "UNSIGNED_APK=%PROJECT_DIR%\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk"
set "ALIGNED_APK=%TEMP%\amll-release-aligned.apk"
set "SIGNED_APK=%TEMP%\amll-release-signed.apk"
set "PACKAGE_ID=net.stevexmh.amllplayer"
set "DEVICE_SERIAL=AMNZZXYDIVW4HEQW"

set "DEBUG_KS=%USERPROFILE%\.android\debug.keystore"

echo ===== Environment =====
echo JAVA_HOME=%JAVA_HOME%
echo ANDROID_HOME=%ANDROID_HOME%
echo ANDROID_NDK_HOME=%ANDROID_NDK_HOME%
echo BUILD_TOOLS_DIR=%BUILD_TOOLS_DIR%
echo FFMPEG_DIR=%FFMPEG_DIR%
echo PROJECT_DIR=%PROJECT_DIR%
echo DEVICE_SERIAL=%DEVICE_SERIAL%
echo DEBUG_KS=%DEBUG_KS%
echo.

if not exist "%JAVA_HOME%\bin\java.exe" (
  echo [FAIL] JDK not found at %JAVA_HOME%
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
if not exist "%ANDROID_NDK_HOME%" (
  echo [FAIL] NDK not found at %ANDROID_NDK_HOME%
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
if not exist "%FFMPEG_DIR%\lib\libavcodec.a" (
  echo [FAIL] Android FFmpeg libavcodec.a not found in %FFMPEG_DIR%\lib
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
if not exist "%APKSIGNER%" (
  echo [FAIL] apksigner not found at %APKSIGNER%
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
if not exist "%ZIPALIGN%" (
  echo [FAIL] zipalign not found at %ZIPALIGN%
  set "RUN_EXIT_CODE=1"
  goto finish_script
)

if not exist "%DEBUG_KS%" (
  echo [INFO] %DEBUG_KS% missing, generating one ...
  if not exist "%USERPROFILE%\.android" mkdir "%USERPROFILE%\.android"
  "%JAVA_HOME%\bin\keytool.exe" -genkeypair -v ^
    -keystore "%DEBUG_KS%" ^
    -storepass android -keypass android ^
    -alias androiddebugkey ^
    -keyalg RSA -keysize 2048 -validity 10000 ^
    -dname "CN=Android Debug,O=Android,C=US"
  if errorlevel 1 (
    echo [FAIL] keytool failed to generate debug.keystore
    set "RUN_EXIT_CODE=1"
    goto finish_script
  )
)

echo ===== adb devices =====
adb devices
echo.

echo ===== Building release APK (aarch64) =====
cd /d "%PROJECT_DIR%"
if errorlevel 1 (
  echo cd failed
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
call pnpm tauri android build --apk --target aarch64
if errorlevel 1 (
  echo [FAIL] tauri android build failed
  set "RUN_EXIT_CODE=1"
  goto finish_script
)

if not exist "%UNSIGNED_APK%" (
  echo [FAIL] unsigned APK not found at %UNSIGNED_APK%
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
echo Unsigned APK: %UNSIGNED_APK%
echo.

echo ===== zipalign =====
if exist "%ALIGNED_APK%" del /q "%ALIGNED_APK%"
"%ZIPALIGN%" -p -f 4 "%UNSIGNED_APK%" "%ALIGNED_APK%"
if errorlevel 1 (
  echo [FAIL] zipalign failed
  set "RUN_EXIT_CODE=1"
  goto finish_script
)

echo ===== apksigner sign with debug key =====
if exist "%SIGNED_APK%" del /q "%SIGNED_APK%"
call "%APKSIGNER%" sign ^
  --ks "%DEBUG_KS%" ^
  --ks-pass pass:android ^
  --key-pass pass:android ^
  --ks-key-alias androiddebugkey ^
  --out "%SIGNED_APK%" ^
  "%ALIGNED_APK%"
if errorlevel 1 (
  echo [FAIL] apksigner sign failed
  set "RUN_EXIT_CODE=1"
  goto finish_script
)
echo Signed APK: %SIGNED_APK%
echo.

echo ===== Installing to device %DEVICE_SERIAL% =====
adb -s %DEVICE_SERIAL% install -r "%SIGNED_APK%"
if errorlevel 1 (
  echo [WARN] install -r failed, trying uninstall + install ...
  adb -s %DEVICE_SERIAL% uninstall %PACKAGE_ID%
  adb -s %DEVICE_SERIAL% install "%SIGNED_APK%"
  if errorlevel 1 (
    echo [FAIL] install failed. Possible causes:
    echo   - existing build has different signature: uninstall first
    echo   - MIUI: enable "Install via USB" in developer options
    echo   - device offline / not authorized
    echo   - install dialog on phone needs manual confirm
    set "RUN_EXIT_CODE=1"
    goto finish_script
  )
)

echo ===== Launching %PACKAGE_ID% on %DEVICE_SERIAL% =====
adb -s %DEVICE_SERIAL% shell monkey -p %PACKAGE_ID% -c android.intent.category.LAUNCHER 1

echo.
echo ===== DONE (release) =====

:finish_script
echo.
choice /c RQ /n /m "Press R to rerun, Q to quit: "
if errorlevel 2 goto end_script
if errorlevel 1 goto run_script

:end_script
endlocal & exit /b %RUN_EXIT_CODE%
