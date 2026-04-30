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

        @JvmStatic
        fun getInstance(): MainActivity? = instance

        @JvmStatic
        fun pickDirectoryTree(): String? {
            val activity = instance ?: return null
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
