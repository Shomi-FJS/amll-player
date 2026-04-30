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
    // 以字段初始化的方式注册 SAF 目录选择器。通过服毒AndroidX文档，这是官方推荐的书写姿势：不论 `super.onCreate()` 被怎么改动，它都会在 Activity 进入
    // STARTED 状态之前完成注册，避免“必须在 onCreate 之前调用”报错。
    private val directoryPickerLauncher: ActivityResultLauncher<Uri?> =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            pendingDirectoryResult = uri?.toString()
            pendingDirectoryLatch?.countDown()
            pendingDirectoryLatch = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        setupImmersiveUi()
        super.onCreate(savedInstanceState)
        instance = this

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

        /**
         * 唤起系统 SAF 目录选择器（`ACTION_OPEN_DOCUMENT_TREE`），并阻塞调用线程，直到用户选定目录或取消。
         * **严禁在 UI 主线程调用**：选择器本身就跑在 UI 线程上，本函数会通过 [CountDownLatch] 阻塞等待返回，在 UI 线程调用会造成死锁。
         * @return 用户选中的 tree URI（如 `content://...tree/...`）；用户取消或
         *         Activity 不可用时返回 `null`。
         */
        @JvmStatic
        fun getInstance(): MainActivity? = instance

        @JvmStatic
        fun pickDirectoryTree(): String? {
            val activity = instance ?: return null
            // 万一上一次调用因异常遗留了没释放的 latch，这里先释放掉。
            pendingDirectoryLatch?.countDown()
            val latch = CountDownLatch(1)
            pendingDirectoryLatch = latch
            pendingDirectoryResult = null
            activity.runOnUiThread {
                try {
                    activity.directoryPickerLauncher.launch(null)
                } catch (e: Throwable) {
                    pendingDirectoryResult = null
                    latch.countDown()
                }
            }
            // 设一个上限，以防选择器卡住时把工作线程永久挂起。
            // 10 分钟已远远超过任何现实场景下用户选目录需要的时间。
            latch.await(10, TimeUnit.MINUTES)
            return pendingDirectoryResult
        }
    }

    override fun onResume() {
        super.onResume()

        checkAllFilesAccessPermission()
    }

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

    private fun checkAllFilesAccessPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                AlertDialog.Builder(this)
                    .setTitle(R.string.all_files_access_required_title)
                    .setMessage(R.string.all_files_access_required_text)
                    .setPositiveButton(R.string.all_files_access_required_go_to_setting) { _, _ ->
                        try {
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
