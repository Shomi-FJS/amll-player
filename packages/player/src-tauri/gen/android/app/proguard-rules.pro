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
-keep class net.stevexmh.amllplayer.MediaSessionHelper { *; }
-keepclassmembers class net.stevexmh.amllplayer.MainActivity {
    public static java.lang.String pickDirectoryTree();
    public static net.stevexmh.amllplayer.MainActivity getInstance();
}
-keepclassmembers class net.stevexmh.amllplayer.MediaSessionHelper {
    public static void init();
    public static void setEnabled(boolean);
    public static void setPlaying(boolean);
    public static void setTitle(java.lang.String);
    public static void setArtist(java.lang.String);
    public static void setDuration(double);
    public static void setPosition(double);
    public static void setCoverImage(byte[]);
    public static void updateMetadata();
    public static java.lang.String pollCommand();
    public static void release();
}