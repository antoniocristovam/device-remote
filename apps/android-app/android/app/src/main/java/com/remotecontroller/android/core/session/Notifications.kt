package com.remotecontroller.android.core.session

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import androidx.core.app.NotificationCompat
import com.remotecontroller.android.MainActivity
import com.remotecontroller.android.R

object Notifications {
    const val SESSION_ID = 1001
    private const val REQUEST_ID = 1002
    private const val CH_SESSION = "rc_session"
    private const val CH_REQUEST = "rc_request"

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_SESSION, "Sessão de controle remoto ativa", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Indica enquanto este aparelho está sendo visto ou controlado"
                setShowBadge(true)
                enableLights(true)
                lightColor = Color.RED
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_REQUEST, "Pedidos de conexão", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Quando um computador pareado pede para controlar este aparelho"
            },
        )
    }

    private fun openApp(ctx: Context) = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /**
     * Persistent session notification (status bar icon). If the user swipes it away on Android 14+,
     * the delete intent makes the service post it again: it lives exactly as long as the session.
     */
    fun session(ctx: Context, peerName: String): Notification {
        ensureChannels(ctx)
        val end = PendingIntent.getService(
            ctx, 1, Intent(ctx, RemoteSessionService::class.java).setAction(RemoteSessionService.ACTION_END),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val repost = PendingIntent.getService(
            ctx, 2, Intent(ctx, RemoteSessionService::class.java).setAction(RemoteSessionService.ACTION_REPOST),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(ctx, CH_SESSION)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setColor(Color.parseColor("#DC2626"))
            .setColorized(true)
            .setContentTitle("Controle remoto ativo")
            .setContentText("$peerName está vendo e controlando este aparelho")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp(ctx))
            .setDeleteIntent(repost)
            .addAction(0, "Encerrar agora", end)
            .build()
    }

    fun showRequest(ctx: Context, peerName: String) {
        ensureChannels(ctx)
        val n = NotificationCompat.Builder(ctx, CH_REQUEST)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setContentTitle("Pedido de controle remoto")
            .setContentText("$peerName quer ver e controlar este aparelho. Toque para responder.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(REQUEST_ID, n) }
    }

    fun cancelRequest(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(REQUEST_ID)
}
