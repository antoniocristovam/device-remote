package com.remotecontroller.android.core.session

import android.app.NotificationManager
import android.app.Service
import android.content.ComponentCallbacks
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import com.remotecontroller.android.core.RcCore

/**
 * Foreground service (type mediaProjection) that exists exactly while a session is active.
 * Its notification is the persistent indicator; "Encerrar agora" ends the session instantly.
 */
class RemoteSessionService : Service() {
    private val core get() = RcCore.get(this)

    private val config = object : ComponentCallbacks {
        override fun onConfigurationChanged(newConfig: Configuration) {
            core.sessions.onDisplayChanged()
        }

        @Deprecated("Deprecated in Java")
        override fun onLowMemory() {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val peerName = core.sessions.pending?.peer?.name ?: "Um computador"
                val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
                ServiceCompat.startForeground(this, Notifications.SESSION_ID, Notifications.session(this, peerName), type)
                val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)
                }
                if (data == null) {
                    core.sessions.end("error")
                    return START_NOT_STICKY
                }
                registerComponentCallbacks(config)
                core.sessions.onServiceStarted(this, data)
            }
            ACTION_END -> core.sessions.end("revoked")
            ACTION_REPOST -> core.sessions.active?.let {
                getSystemService(NotificationManager::class.java).notify(Notifications.SESSION_ID, Notifications.session(this, it.peer.name))
            }
            else -> if (core.sessions.active == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        runCatching { unregisterComponentCallbacks(config) }
        // Service killed by the system or user (e.g. force-stop from settings): never keep capturing.
        if (core.sessions.active != null) core.sessions.end("revoked")
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.remotecontroller.android.session.START"
        const val ACTION_END = "com.remotecontroller.android.session.END"
        const val ACTION_REPOST = "com.remotecontroller.android.session.REPOST"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
    }
}
