package net.stevexmh.amllplayer

import android.service.notification.NotificationListenerService

/**
 * Shell NotificationListenerService。
 *
 * 它本身不处理通知；存在的唯一目的是：给本 App 注册一个 NLS 组件，让用户在
 * 「设置 → 通知使用权」中授权后，App 拿到查询其它进程 MediaSession
 * （`MediaSessionManager.getActiveSessions`）所需的运行时权限。
 *
 * Android 平台对非系统应用读取其它应用 MediaSession 的唯一合法路径就是
 * 这个 NLS 权限，参见 `MediaSessionManager.getActiveSessions(ComponentName)`
 * 文档。
 */
class MediaCaptureNotificationListener : NotificationListenerService()
