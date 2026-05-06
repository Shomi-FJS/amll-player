package net.stevexmh.amllplayer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 捕捉**其它应用**通过 [android.media.session.MediaSession] 暴露出的播放信息
 * 与控制接口，并把变更事件以 JSON 字符串形式排进 [eventQueue]，让 Rust 端
 * 通过 [pollEvent] 轮询消费、再通过 Tauri Event 推送到前端。
 *
 * 实现要点：
 * - 列举 / 订阅依赖 `BIND_NOTIFICATION_LISTENER_SERVICE` 权限（用户在系统
 *   设置里授权我们的 [MediaCaptureNotificationListener]）。
 * - 任何对 [MediaController] 的注册 / 注销、[MediaSessionManager] 的回调注册
 *   都必须在主线程；Rust JNI 线程没有 Looper，所以这里全部 post 到 mainHandler。
 * - 控制方法（play/pause/...）也要在主线程派发，否则 transportControls 内部
 *   `MediaSession.Token` 的 IPC 在某些机型上会异常。
 */
object MediaCaptureManager {
    private const val TAG = "MediaCaptureManager"

    private val mainHandler = Handler(Looper.getMainLooper())
    // 上限 256，防止前端长时间不连接时事件无限堆积；超出后丢最旧的。
    private val eventQueue = LinkedBlockingQueue<String>(256)

    @Volatile private var sessionManager: MediaSessionManager? = null
    @Volatile private var listenerComponent: ComponentName? = null
    @Volatile private var started = false

    // 当前订阅的控制器（被选中作为播放上下文的会话）
    @Volatile private var currentController: MediaController? = null
    private var currentCallback: MediaController.Callback? = null

    // 上次成功 push 出去的 metadata 签名（title|artist|album|duration|packageName）。
    // 部分播放器在一首歌内会反复触发 onMetadataChanged（buffering / 流切换 / 进度
    // 边界），如果每次都重发，封面 JPEG+base64 + 1MB 文本会反复经过 JNI/Tauri
    // Event 拷贝到前端，造成肉眼可见的卡顿。新会话和真正换歌时这个签名会被重置。
    @Volatile private var lastMetadataSig: String? = null

    private val sessionsChangedListener =
        MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
            emitSessions(controllers ?: emptyList())
            // 当前订阅的会话被系统回收后，自动清掉订阅；不主动选新会话，让前端
            // 自己决定下一个目标，避免「我刚切到 A 又被你抢回 B」的反直觉行为。
            val cur = currentController
            if (cur != null && controllers?.none { it.sessionToken == cur.sessionToken } == true) {
                detachCurrent()
                pushEvent(JSONObject().apply {
                    put("type", "selectionLost")
                })
            }
        }

    @JvmStatic
    fun hasPermission(): Boolean {
        val activity = MainActivity.getInstance() ?: return false
        return NotificationManagerCompat
            .getEnabledListenerPackages(activity)
            .contains(activity.packageName)
    }

    @JvmStatic
    fun openPermissionSettings() {
        val activity = MainActivity.getInstance() ?: return
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
        } catch (e: Throwable) {
            Log.w(TAG, "Cannot open NLS settings", e)
        }
    }

    /**
     * 注册全局会话变更监听并立即推送当前会话列表。幂等。
     * @return 是否真正进入运行状态（无权限时返回 false）。
     */
    @JvmStatic
    fun start(): Boolean {
        if (started) return true
        if (!hasPermission()) return false
        val activity = MainActivity.getInstance() ?: return false

        val latch = java.util.concurrent.CountDownLatch(1)
        var ok = false
        mainHandler.post {
            try {
                val sm = activity.getSystemService(Context.MEDIA_SESSION_SERVICE)
                    as MediaSessionManager
                val comp = ComponentName(activity, MediaCaptureNotificationListener::class.java)
                sm.addOnActiveSessionsChangedListener(sessionsChangedListener, comp)
                sessionManager = sm
                listenerComponent = comp
                started = true
                ok = true
                emitSessions(sm.getActiveSessions(comp))
            } catch (e: SecurityException) {
                Log.w(TAG, "start: missing NLS permission", e)
            } catch (e: Throwable) {
                Log.e(TAG, "start failed", e)
            } finally {
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return ok
    }

    @JvmStatic
    fun stop() {
        if (!started) return
        mainHandler.post {
            try {
                sessionManager?.removeOnActiveSessionsChangedListener(sessionsChangedListener)
            } catch (_: Throwable) {
            }
            detachCurrent()
            sessionManager = null
            listenerComponent = null
            started = false
            eventQueue.clear()
        }
    }

    /** 返回 JSON：`[{packageName, sessionId, isCurrent}]`。 */
    @JvmStatic
    fun listSessions(): String {
        val sm = sessionManager ?: return "[]"
        val comp = listenerComponent ?: return "[]"
        val curToken = currentController?.sessionToken
        return try {
            val arr = JSONArray()
            for (c in sm.getActiveSessions(comp)) {
                arr.put(JSONObject().apply {
                    put("packageName", c.packageName ?: "")
                    put("sessionId", System.identityHashCode(c.sessionToken))
                    put("isCurrent", c.sessionToken == curToken)
                })
            }
            arr.toString()
        } catch (e: Throwable) {
            Log.w(TAG, "listSessions failed", e)
            "[]"
        }
    }

    /**
     * 选定某个 packageName 对应的活跃 MediaSession 作为当前订阅目标。
     * 同一个进程里同 packageName 可能有多个会话（罕见），这里取
     * `getActiveSessions` 列表里第一个匹配项，已能覆盖几乎所有播放器场景。
     * 传空串表示取消当前订阅。
     */
    @JvmStatic
    fun selectSession(packageName: String) {
        val sm = sessionManager ?: return
        val comp = listenerComponent ?: return
        mainHandler.post {
            try {
                detachCurrent()
                if (packageName.isEmpty()) {
                    pushEvent(JSONObject().apply { put("type", "selectionCleared") })
                    return@post
                }
                val target = sm.getActiveSessions(comp)
                    .firstOrNull { it.packageName == packageName }
                if (target == null) {
                    pushEvent(JSONObject().apply {
                        put("type", "selectionFailed")
                        put("packageName", packageName)
                    })
                    return@post
                }
                attachController(target)
            } catch (e: Throwable) {
                Log.e(TAG, "selectSession failed", e)
            }
        }
    }

    /**
     * 给当前订阅的会话发控制命令。`arg` 仅 seek 命令使用（毫秒）。
     * 未订阅时静默丢弃。
     */
    @JvmStatic
    fun sendCommand(cmd: String, arg: Long) {
        val ctrl = currentController ?: return
        mainHandler.post {
            try {
                val tc = ctrl.transportControls
                when (cmd) {
                    "play" -> tc.play()
                    "pause" -> tc.pause()
                    "next" -> tc.skipToNext()
                    "previous" -> tc.skipToPrevious()
                    "seek" -> tc.seekTo(arg)
                    "stop" -> tc.stop()
                    else -> Log.w(TAG, "Unknown cmd: $cmd")
                }
            } catch (e: Throwable) {
                Log.w(TAG, "sendCommand $cmd failed", e)
            }
        }
    }

    /**
     * Rust 后台轮询线程调用。最多阻塞 [timeoutMs] 毫秒，等到事件就立刻返回；
     * 超时返回 null，让调用方有机会检查取消标志后重新进入。
     */
    @JvmStatic
    fun pollEvent(timeoutMs: Long): String? = try {
        eventQueue.poll(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
        null
    }

    // ─────────────────── 内部 ───────────────────

    private fun detachCurrent() {
        val ctrl = currentController
        val cb = currentCallback
        if (ctrl != null && cb != null) {
            try {
                ctrl.unregisterCallback(cb)
            } catch (_: Throwable) {
            }
        }
        currentController = null
        currentCallback = null
        lastMetadataSig = null
    }

    private fun attachController(ctrl: MediaController) {
        val cb = object : MediaController.Callback() {
            override fun onMetadataChanged(metadata: MediaMetadata?) {
                emitMetadataIfChanged(ctrl, metadata)
            }

            override fun onPlaybackStateChanged(state: PlaybackState?) {
                pushEvent(buildPlaybackStateEvent(state))
            }

            override fun onSessionDestroyed() {
                pushEvent(JSONObject().apply { put("type", "selectionLost") })
                mainHandler.post { detachCurrent() }
            }
        }
        ctrl.registerCallback(cb, mainHandler)
        currentController = ctrl
        currentCallback = cb
        // 新订阅一定要让首次 metadata 推过去，所以重置签名。
        lastMetadataSig = null

        // 立刻推送一次当前快照，避免前端先看到一段空白
        pushEvent(JSONObject().apply {
            put("type", "selected")
            put("packageName", ctrl.packageName ?: "")
        })
        emitMetadataIfChanged(ctrl, ctrl.metadata)
        pushEvent(buildPlaybackStateEvent(ctrl.playbackState))
    }

    /**
     * 仅当 metadata 关键字段（标题/艺术家/专辑/时长/包名）发生变化时才构建事件
     * 并 push。封面 JPEG 压缩与 base64 编码都很重，绝不能在 dedup 之前做。
     */
    private fun emitMetadataIfChanged(ctrl: MediaController, md: MediaMetadata?) {
        val sig = buildMetadataSig(ctrl, md)
        if (sig == lastMetadataSig) return
        lastMetadataSig = sig
        pushEvent(buildMetadataEvent(ctrl, md))
    }

    private fun buildMetadataSig(ctrl: MediaController, md: MediaMetadata?): String {
        if (md == null) return "${ctrl.packageName}|null"
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""
        val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: ""
        val album = md.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: ""
        val duration = md.getLong(MediaMetadata.METADATA_KEY_DURATION)
        // 封面状态也要进 sig：很多播放器切歌后会先发不带封面的 metadata，再发
        // 带封面的；如果只比较 title/artist/album/duration，第二次会被错误地
        // dedup 掉，结果前端永远拿不到封面。这里取 bitmap 的 (width, byteCount)
        // 作为指纹——只读字段不触发编码，零开销。低清→高清升级也能识别。
        val bmp: Bitmap? = md.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
        val coverFp = bmp?.let { "${it.width}x${it.byteCount}" } ?: "null"
        return "${ctrl.packageName}\u0001$title\u0001$artist\u0001$album\u0001$duration\u0001$coverFp"
    }

    private fun emitSessions(controllers: List<MediaController>) {
        val arr = JSONArray()
        val curToken = currentController?.sessionToken
        for (c in controllers) {
            arr.put(JSONObject().apply {
                put("packageName", c.packageName ?: "")
                put("sessionId", System.identityHashCode(c.sessionToken))
                put("isCurrent", c.sessionToken == curToken)
            })
        }
        pushEvent(JSONObject().apply {
            put("type", "sessions")
            put("list", arr)
        })
    }

    private fun buildMetadataEvent(ctrl: MediaController, md: MediaMetadata?): JSONObject {
        val obj = JSONObject()
        obj.put("type", "metadata")
        obj.put("packageName", ctrl.packageName ?: "")
        if (md == null) {
            obj.put("title", "")
            obj.put("artist", "")
            obj.put("album", "")
            obj.put("duration", 0L)
            obj.put("cover", "")
            return obj
        }
        obj.put("title", md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: "")
        obj.put(
            "artist",
            md.getString(MediaMetadata.METADATA_KEY_ARTIST)
                ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: ""
        )
        obj.put("album", md.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: "")
        obj.put("duration", md.getLong(MediaMetadata.METADATA_KEY_DURATION))
        // 优先 ART > ALBUM_ART > DISPLAY_ICON。base64 直接喂前端做 data URL，
        // 比起再发一个 IPC 拉 byte[] 简单很多。
        val bmp: Bitmap? = md.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
        if (bmp != null) {
            try {
                obj.put("cover", encodeBitmapToBase64(bmp))
            } catch (_: Throwable) {
                obj.put("cover", "")
            }
        } else {
            obj.put("cover", "")
        }
        return obj
    }

    /**
     * 把封面缩放到不超过 [COVER_MAX_DIM] 后用 JPEG-[COVER_QUALITY] 压缩 + base64。
     * 原始封面常见 1024×1024 甚至更大，直接编码会产出 1MB+ 文本，IPC 拷贝
     * 阻塞主线程；前端只用作背景虚化和缩略图，256 边长 + 质量 60 已经够看。
     */
    private fun encodeBitmapToBase64(src: Bitmap): String {
        val maxSide = maxOf(src.width, src.height)
        val scaled = if (maxSide > COVER_MAX_DIM) {
            val ratio = COVER_MAX_DIM.toFloat() / maxSide
            val w = (src.width * ratio).toInt().coerceAtLeast(1)
            val h = (src.height * ratio).toInt().coerceAtLeast(1)
            // 用 filter=true 双线性，避免锐利锯齿；这是一次性开销可以接受。
            Bitmap.createScaledBitmap(src, w, h, true)
        } else {
            src
        }
        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, COVER_QUALITY, baos)
        // createScaledBitmap 可能返回新 Bitmap，及时 recycle 避免 Java 堆抖动。
        if (scaled !== src) {
            try { scaled.recycle() } catch (_: Throwable) {}
        }
        return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
    }

    private const val COVER_MAX_DIM = 256
    private const val COVER_QUALITY = 60

    private fun buildPlaybackStateEvent(state: PlaybackState?): JSONObject {
        val obj = JSONObject()
        obj.put("type", "playbackState")
        if (state == null) {
            obj.put("playing", false)
            obj.put("position", 0L)
            obj.put("speed", 1.0)
            obj.put("updateTime", System.currentTimeMillis())
            return obj
        }
        obj.put("playing", state.state == PlaybackState.STATE_PLAYING)
        obj.put("position", state.position)
        obj.put("speed", state.playbackSpeed.toDouble())
        // state.lastPositionUpdateTime 用的是 SystemClock.elapsedRealtime() 时基
        // （自开机毫秒），与 JS 的 Date.now()（1970 epoch）完全不同。这里换算成
        // System.currentTimeMillis() 时基再送出去：前端拿到的 updateTime 直接减
        // Date.now() 就是真实的「自采样时刻过去了多少 ms」。
        val nowElapsed = SystemClock.elapsedRealtime()
        val nowWall = System.currentTimeMillis()
        val sampleWallClock = if (state.lastPositionUpdateTime > 0) {
            nowWall - (nowElapsed - state.lastPositionUpdateTime)
        } else {
            nowWall
        }
        obj.put("updateTime", sampleWallClock)
        obj.put("rawState", state.state)
        return obj
    }

    private fun pushEvent(obj: JSONObject) {
        val s = obj.toString()
        // 队列满时丢最旧一条，给新事件让位（旧事件在很短时间内已被新事件取代）。
        if (!eventQueue.offer(s)) {
            eventQueue.poll()
            eventQueue.offer(s)
        }
    }
}
