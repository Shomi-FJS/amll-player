package net.stevexmh.amllplayer

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object MediaSessionHelper {
    private const val TAG = "MediaSessionHelper"
    private const val CHANNEL_ID = "amll_player_media"
    private const val NOTIFICATION_ID = 1

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var session: MediaSessionCompat? = null

    @Volatile
    private var isEnabled = false

    private val commandQueue = java.util.concurrent.LinkedBlockingQueue<String>()

    @Volatile private var currentTitle: String = ""
    @Volatile private var currentArtist: String = ""
    @Volatile private var currentDuration: Long = 0L
    @Volatile private var currentPosition: Long = 0L
    @Volatile private var currentIsPlaying: Boolean = false
    @Volatile private var currentCoverBitmap: Bitmap? = null

    @JvmStatic
    fun init() {
        if (session != null) return

        val activity = MainActivity.getInstance() ?: run {
            Log.w(TAG, "init: MainActivity not available")
            return
        }

        val latch = java.util.concurrent.CountDownLatch(1)
        var initError: Throwable? = null

        mainHandler.post {
            try {
                if (session != null) {
                    latch.countDown()
                    return@post
                }

                createNotificationChannel(activity)

                val mediaSession = MediaSessionCompat(activity, "AMLLPlayer").apply {
                    setCallback(object : MediaSessionCompat.Callback() {
                        override fun onPlay() {
                            commandQueue.offer("play")
                        }
                        override fun onPause() {
                            commandQueue.offer("pause")
                        }
                        override fun onSkipToNext() {
                            commandQueue.offer("next")
                        }
                        override fun onSkipToPrevious() {
                            commandQueue.offer("previous")
                        }
                        override fun onSeekTo(pos: Long) {
                            commandQueue.offer("seek:${pos / 1000.0}")
                        }
                        override fun onStop() {
                            commandQueue.offer("pause")
                        }
                    })

                    val intent = Intent(activity, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val pi = PendingIntent.getActivity(
                        activity, 0, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                    setSessionActivity(pi)
                }

                session = mediaSession
                Log.i(TAG, "MediaSession initialized on main thread")
            } catch (e: Throwable) {
                Log.e(TAG, "Failed to init MediaSession", e)
                initError = e
            } finally {
                latch.countDown()
            }
        }

        try {
            latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Log.w(TAG, "init: interrupted while waiting")
        }

        if (initError != null) {
            Log.e(TAG, "init failed: ${initError!!.message}")
        }
    }

    @JvmStatic
    fun setEnabled(enabled: Boolean) {
        isEnabled = enabled
        mainHandler.post {
            try {
                session?.isActive = enabled
                if (enabled) {
                    updatePlaybackStateInternal()
                    updateMetadataInternal()
                    postNotification()
                } else {
                    cancelNotification()
                }
            } catch (e: Throwable) {
                Log.e(TAG, "setEnabled failed", e)
            }
        }
    }

    @JvmStatic
    fun setPlaying(playing: Boolean) {
        currentIsPlaying = playing
        mainHandler.post {
            try {
                updatePlaybackStateInternal()
                if (isEnabled) postNotification()
            } catch (e: Throwable) {
                Log.e(TAG, "setPlaying failed", e)
            }
        }
    }

    @JvmStatic
    fun setTitle(title: String) {
        currentTitle = title
    }

    @JvmStatic
    fun setArtist(artist: String) {
        currentArtist = artist
    }

    @JvmStatic
    fun setDuration(durationSec: Double) {
        currentDuration = (durationSec * 1000).toLong()
    }

    @JvmStatic
    fun setPosition(positionSec: Double) {
        currentPosition = (positionSec * 1000).toLong()
    }

    @JvmStatic
    fun setCoverImage(coverData: ByteArray) {
        currentCoverBitmap = if (coverData.isEmpty()) {
            null
        } else {
            try {
                BitmapFactory.decodeByteArray(coverData, 0, coverData.size)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to decode cover image", e)
                null
            }
        }
    }

    @JvmStatic
    fun updateMetadata() {
        mainHandler.post {
            try {
                updateMetadataInternal()
                if (isEnabled) postNotification()
            } catch (e: Throwable) {
                Log.e(TAG, "updateMetadata failed", e)
            }
        }
    }

    @JvmStatic
    fun pollCommand(): String? {
        return try {
            commandQueue.poll(100, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            null
        }
    }

    @JvmStatic
    fun release() {
        mainHandler.post {
            session?.let {
                it.isActive = false
                it.release()
            }
            session = null
            cancelNotification()
        }
        commandQueue.clear()
        Log.i(TAG, "MediaSession released")
    }

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Media Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows media playback controls"
                setShowBadge(false)
            }
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun updatePlaybackStateInternal() {
        val s = session ?: return
        val state = if (currentIsPlaying) {
            PlaybackStateCompat.STATE_PLAYING
        } else {
            PlaybackStateCompat.STATE_PAUSED
        }
        val playbackSpeed = if (currentIsPlaying) 1.0f else 0.0f
        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                PlaybackStateCompat.ACTION_SEEK_TO or
                PlaybackStateCompat.ACTION_STOP
            )
            .setState(state, currentPosition, playbackSpeed)
        s.setPlaybackState(stateBuilder.build())
    }

    private fun updateMetadataInternal() {
        val s = session ?: return
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ARTIST, currentArtist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDuration)
        currentCoverBitmap?.let {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
        }
        s.setMetadata(builder.build())
    }

    private fun postNotification() {
        val ctx = MainActivity.getInstance() ?: return
        val s = session ?: return

        val notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle.ifEmpty { "AMLL Player" })
            .setContentText(currentArtist)
            .setLargeIcon(currentCoverBitmap)
            .setOngoing(currentIsPlaying)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(s.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .setContentIntent(s.controller.sessionActivity)
            .addAction(
                android.R.drawable.ic_media_previous,
                "Previous",
                buildMediaAction(PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
            )
            .addAction(
                if (currentIsPlaying) android.R.drawable.ic_media_pause
                else android.R.drawable.ic_media_play,
                if (currentIsPlaying) "Pause" else "Play",
                buildMediaAction(
                    if (currentIsPlaying) PlaybackStateCompat.ACTION_PAUSE
                    else PlaybackStateCompat.ACTION_PLAY
                )
            )
            .addAction(
                android.R.drawable.ic_media_next,
                "Next",
                buildMediaAction(PlaybackStateCompat.ACTION_SKIP_TO_NEXT)
            )
            .build()

        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "No notification permission", e)
        }
    }

    private fun cancelNotification() {
        val ctx = MainActivity.getInstance() ?: return
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)
    }

    private fun buildMediaAction(action: Long): PendingIntent {
        val ctx = MainActivity.getInstance()!!
        val intent = Intent(Intent.ACTION_MEDIA_BUTTON).apply {
            setPackage(ctx.packageName)
        }
        return PendingIntent.getBroadcast(
            ctx, action.toInt(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
