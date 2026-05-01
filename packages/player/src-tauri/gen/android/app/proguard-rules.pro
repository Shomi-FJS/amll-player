# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# 保留 MainActivity 及其反射/JNI 调用的成员（SAF 目录选择桥接）。
# Rust 侧通过 JNI 反射调用 pickDirectoryTree，R8 默认不知道，会被裁掉/改名。
-keep class net.stevexmh.amllplayer.MainActivity {
    public static java.lang.String pickDirectoryTree();
    *;
}
-keep class net.stevexmh.amllplayer.MainActivity$Companion { *; }
-keepclassmembers class net.stevexmh.amllplayer.MainActivity {
    static <fields>;
    androidx.activity.result.ActivityResultLauncher directoryPickerLauncher;
}

# Tauri/Wry 自身使用了反射加载 WebView 桥；保险起见保留全部 app 包类。
-keep class net.stevexmh.amllplayer.** { *; }