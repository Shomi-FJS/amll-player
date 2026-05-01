package net.stevexmh.amllplayer

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.net.toUri
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
    // SAF 目录选择器；结果通过 latch 回送给阻塞中的 JNI 线程
    private val directoryPickerLauncher: ActivityResultLauncher<Uri?> =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            pendingDirectoryResult = uri?.toString()
            pendingDirectoryLatch?.countDown()
            pendingDirectoryLatch = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // 必须在 super.onCreate 前配置，否则首帧 inset 不生效
        setupImmersiveUi()
        super.onCreate(savedInstanceState)
        // 暴露给 companion，供 Rust 通过 getInstance() 调用
        instance = this

        // 进程被重建时，旧 launcher 已随旧 Activity 被销；latch 却可能还被 Rust
        // 侧的 JNI 线程 await 着，永远等不到回调。此时主动让它返回 null。
        pendingDirectoryLatch?.countDown()
        pendingDirectoryLatch = null
        pendingDirectoryResult = null

        // 播放期间保持屏幕常亮
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
        }
        super.onDestroy()
    }

    companion object {
        @Volatile
        private var instance: MainActivity? = null

        @Volatile
        private var pendingDirectoryLatch: CountDownLatch? = null

        @Volatile
        private var pendingDirectoryResult: String? = null

        @JvmStatic
        fun getInstance(): MainActivity? = instance

        // 由 Rust 通过 JNI 调用：在 UI 线程弹目录选择器，调用线程阻塞等回调
        @JvmStatic
        fun pickDirectoryTree(): String? {
            val activity = instance ?: return null
            // 释放上一次未完成的等待，避免悬挂
            pendingDirectoryLatch?.countDown()
            val latch = CountDownLatch(1)
            pendingDirectoryLatch = latch
            pendingDirectoryResult = null
            activity.runOnUiThread {
                try {
                    activity.directoryPickerLauncher.launch(null)
                } catch (e: Throwable) {
                    // launch 失败时立即解除阻塞
                    pendingDirectoryResult = null
                    latch.countDown()
                }
            }
            // 上限 5 分钟；足够用户完成选择，又能在 Activity 崩溃/切后台被
            // 杀期间避免 Rust 侧 JNI 线程长时间挂起。
            latch.await(5, TimeUnit.MINUTES)
            return pendingDirectoryResult
        }
    }

    override fun onResume() {
        super.onResume()

        // 每次回到前台都复查权限（用户可能在系统设置里改过）
        checkAllFilesAccessPermission()
    }

    // 透明状态/导航栏 + 沉浸式：系统栏默认隐藏，用户上滑时短暂显示
    private fun setupImmersiveUi() {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT)
        )

        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // R+ 才有 MANAGE_EXTERNAL_STORAGE；未授权时弹对话框引导到系统设置
    private fun checkAllFilesAccessPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                AlertDialog.Builder(this)
                    .setTitle(R.string.all_files_access_required_title)
                    .setMessage(R.string.all_files_access_required_text)
                    .setPositiveButton(R.string.all_files_access_required_go_to_setting) { _, _ ->
                        try {
                            // 优先打开本应用专属页；部分 ROM 不支持时回退到全局列表
                            val intent =
                                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                            intent.addCategory("android.intent.category.DEFAULT")
                            intent.data = "package:${applicationContext.packageName}".toUri()
                            startActivity(intent)
                        } catch (_: Exception) {
                            val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                            startActivity(intent)
                        }
                    }
                    .setNegativeButton(R.string.all_files_access_required_ignore, null)
                    .setCancelable(true)
                    .show()
            }
        }
    }
}
