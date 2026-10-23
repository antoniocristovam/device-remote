package com.remotecontroller.android.core.session

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.core.content.ContextCompat
import com.remotecontroller.android.core.RcCore
import com.remotecontroller.android.core.crypto.SessionCrypto
import com.remotecontroller.android.core.input.ControlAccessibilityService
import com.remotecontroller.android.core.signaling.SignalingClient
import com.remotecontroller.android.core.store.PairedDesktop
import com.remotecontroller.android.core.store.SessionLogEntry
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection

/**
 * Phone side of remote sessions:
 *   sess.req (signed by a pinned desktop) -> user consent in the app -> system screen-capture
 *   consent -> foreground service + persistent indicator -> sess.accept + signed SDP offer.
 * Every path that ends a session goes through [end], which also removes the indicator.
 */
class SessionCoordinator(private val core: RcCore) : SignalingClient.Listener {
    private val main = Handler(Looper.getMainLooper())

    data class Pending(val peer: PairedDesktop, val nonceD: String)

    class Active(val peer: PairedDesktop, val token: SessionCrypto.Token) {
        var rtc: WebRtcSession? = null
        var chat: ChatTransfers? = null
        var connected = false
        /** Set while the peer connection is down; cleared when it reconnects. */
        var downSince: Long? = null
        var reconnects = 0
        var lastRestartAt = 0L
        var everConnected = false
    }

    var pending: Pending? = null
        private set
    var active: Active? = null
        private set

    private var iceServers: List<PeerConnection.IceServer> = DEFAULT_ICE
    private val failTimeout = Runnable { end("lost") }

    /** While the link is down: retry an ICE restart every few seconds as long as signaling is up. */
    private val retryTick: Runnable = object : Runnable {
        override fun run() {
            val a = active ?: return
            if (a.connected || a.downSince == null) return
            // A restart can heal the link without a new state callback: trust the real state.
            if (a.rtc?.isConnected() == true) {
                linkUp(a)
                core.emitState()
                return
            }
            restartIce(a, "retry")
            main.postDelayed(this, RETRY_INTERVAL_MS)
        }
    }

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    init {
        core.signaling.addListener(this)
    }

    fun stateJson(): JSONObject {
        val a = active
        val p = pending
        return when {
            a != null -> JSONObject()
                .put("phase", if (a.connected) "live" else if (a.everConnected) "reconnecting" else "connecting")
                .put("peer", a.peer.toJson()).put("sid", a.token.sid).put("startedAt", a.token.iat)
                .put("reconnects", a.reconnects)
                .put("downSince", a.downSince ?: JSONObject.NULL)
                .put("deadline", a.downSince?.let { it + CONNECT_TIMEOUT_MS } ?: JSONObject.NULL)
            p != null -> JSONObject().put("phase", "request").put("peer", p.peer.toJson())
            else -> JSONObject().put("phase", "idle")
        }
    }

    // ---------------- Consent ----------------

    fun deny(reason: String = "denied by user") {
        val p = pending ?: return
        pending = null
        core.signaling.relay(p.peer.channelId, JSONObject().put("k", "sess.deny").put("reason", reason))
        Notifications.cancelRequest(core.app)
        core.emitState()
    }

    /** Called after the user accepted in the app AND granted the system screen-capture dialog. */
    fun acceptWithProjection(resultCode: Int, data: Intent) {
        if (pending == null) return
        Notifications.cancelRequest(core.app)
        val intent = Intent(core.app, RemoteSessionService::class.java)
            .setAction(RemoteSessionService.ACTION_START)
            .putExtra(RemoteSessionService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(RemoteSessionService.EXTRA_DATA, data)
        ContextCompat.startForegroundService(core.app, intent)
    }

    /** The foreground service is up (indicator visible): now it is legal to start capturing. */
    fun onServiceStarted(service: RemoteSessionService, projectionData: Intent) {
        val p = pending ?: return service.stopSelf()
        pending = null
        val (msg, token) = SessionCrypto.buildAccept(
            p.peer.channelId, p.nonceD, p.peer.fingerprint, core.identity.fingerprint, core.identity,
        )
        val a = Active(p.peer, token)
        a.chat = ChatTransfers(core, p.peer.fingerprint) { a.rtc }
        active = a
        core.stores.touchPeer(p.peer.fingerprint)
        core.stores.logSessionStart(SessionLogEntry(token.sid, p.peer.fingerprint, p.peer.name, System.currentTimeMillis()))
        core.signaling.relay(p.peer.channelId, msg)
        ControlAccessibilityService.instance?.showIndicator(true)

        try {
            a.rtc = WebRtcSession(service, projectionData, iceServers, rtcListener(a))
        } catch (e: Exception) {
            Log.e(TAG, "failed to start WebRTC", e)
            end("error")
            return
        }
        main.postDelayed(failTimeout, CONNECT_TIMEOUT_MS)
        watchNetwork()
        core.emitState()
    }

    fun onDisplayChanged() = active?.rtc?.onDisplayChanged()

    // ---------------- Reconnection ----------------

    /**
     * The phone is the offerer, so it drives recovery: a new offer with fresh ICE credentials.
     * Rate-limited because several triggers (ICE failure, network switch, signaling back, desktop
     * resume) often fire together.
     */
    private fun restartIce(a: Active, why: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - a.lastRestartAt < MIN_RESTART_GAP_MS) return
        if (core.signaling.status != SignalingClient.Status.ONLINE) return
        a.lastRestartAt = now
        Log.i(TAG, "ICE restart ($why)")
        a.rtc?.restartIce()
    }

    private fun linkDown(a: Active, immediate: Boolean) {
        a.connected = false
        if (a.downSince == null) {
            a.downSince = System.currentTimeMillis()
            main.removeCallbacks(failTimeout)
            main.postDelayed(failTimeout, CONNECT_TIMEOUT_MS)
        }
        main.removeCallbacks(retryTick)
        // "disconnected" often heals by itself within a second or two; "failed" never does.
        main.postDelayed(retryTick, if (immediate) 0 else FIRST_RETRY_DELAY_MS)
    }

    private fun linkUp(a: Active) {
        a.connected = true
        if (a.downSince != null && a.everConnected) a.reconnects++
        a.everConnected = true
        a.downSince = null
        main.removeCallbacks(failTimeout)
        main.removeCallbacks(retryTick)
    }

    /** A new default network (e.g. Wi-Fi to mobile data) means the old ICE candidates are dead. */
    private fun watchNetwork() {
        val cm = core.app.getSystemService(ConnectivityManager::class.java) ?: return
        var current: Network? = cm.activeNetwork
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    val a = active ?: return@post
                    if (network == current) return@post
                    current = network
                    Log.i(TAG, "default network changed")
                    // Proactive: the old candidates are gone, so renegotiate now instead of waiting for
                    // ICE to time out. The link is only marked down if the peer connection says so.
                    restartIce(a, "network")
                }
            }


        }
        runCatching { cm.registerDefaultNetworkCallback(cb) }.onSuccess { networkCallback = cb }
    }

    private fun unwatchNetwork() {
        val cb = networkCallback ?: return
        networkCallback = null
        runCatching { core.app.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
    }

    override fun onStatus(status: SignalingClient.Status) {
        val a = active ?: return
        if (status == SignalingClient.Status.ONLINE && !a.connected && a.everConnected) main.post { restartIce(a, "signaling back") }
    }

    // ---------------- Ending ----------------

    fun end(reason: String) {
        val a = active
        if (a == null) {
            deny(reason)
            return
        }
        active = null
        main.removeCallbacks(failTimeout)
        main.removeCallbacks(retryTick)
        unwatchNetwork()
        a.rtc?.sendSessionEnd(reason)
        a.chat?.close()
        core.signaling.relay(a.peer.channelId, JSONObject().put("k", "sess.end").put("sid", a.token.sid).put("reason", reason))
        // Give the end message a moment on the data channel before tearing everything down.
        main.postDelayed({ a.rtc?.close() }, 150)
        core.stores.logSessionEnd(a.token.sid, reason, a.reconnects)
        ControlAccessibilityService.instance?.showIndicator(false)
        core.app.stopService(Intent(core.app, RemoteSessionService::class.java))
        if (!core.available) core.signaling.leave(a.peer.channelId)
        core.emit("sessionEnded", JSONObject().put("reason", reason).put("peerName", a.peer.name))
        core.emitState()
    }

    // ---------------- Signaling ----------------

    override fun onMessage(msg: JSONObject) {
        when (msg.optString("t")) {
            "turn-credentials" -> msg.optJSONArray("iceServers")?.let { arr ->
                val parsed = SignalingClient.parseIceServers(arr).map { (urls, user, cred) ->
                    PeerConnection.IceServer.builder(urls).apply {
                        if (user != null) setUsername(user)
                        if (cred != null) setPassword(cred)
                    }.createIceServer()
                }
                if (parsed.isNotEmpty()) iceServers = parsed
            }
            "relay" -> {
                if (msg.optString("from") != "desktop") return
                val peer = core.stores.peerByChannel(msg.optString("room")) ?: return
                try {
                    onRelay(peer, msg.getJSONObject("data"))
                } catch (e: Exception) {
                    Log.w(TAG, "bad relay message", e)
                }
            }
        }
    }

    private fun onRelay(peer: PairedDesktop, data: JSONObject) {
        val a = active
        when (data.optString("k")) {
            "sess.req" -> {
                if (!SessionCrypto.verifyRequest(peer.channelId, peer.publicKey, data)) return
                if (a != null) {
                    core.signaling.relay(peer.channelId, JSONObject().put("k", "sess.deny").put("reason", "busy"))
                    return
                }
                pending = Pending(peer, data.getString("nonceD"))
                core.signaling.requestTurn()
                Notifications.showRequest(core.app, peer.name)
                core.emit("sessionRequest", JSONObject().put("peer", peer.toJson()))
                core.emitState()
            }
            "sess.resume" -> {
                if (a == null || a.peer.fingerprint != peer.fingerprint || data.optString("sid") != a.token.sid) {
                    // Unknown session (e.g. the app was restarted): tell the desktop so it stops waiting.
                    // Only for authentic requests, so a third party cannot probe or spam the channel.
                    val sid = data.optString("sid")
                    if (SessionCrypto.verifyResume(peer.channelId, peer.publicKey, sid, data)) {
                        core.signaling.relay(peer.channelId, JSONObject().put("k", "sess.end").put("sid", sid).put("reason", "expired"))
                    }
                    return
                }
                if (!SessionCrypto.verifyResume(peer.channelId, peer.publicKey, a.token.sid, data)) return
                if (a.token.exp <= System.currentTimeMillis()) return end("expired")
                restartIce(a, "desktop resume")
            }
            "sdp" -> {
                if (a == null || a.peer.fingerprint != peer.fingerprint || data.optString("sid") != a.token.sid) return
                if (data.optString("type") != "answer") return
                if (!SessionCrypto.verifySdp(peer.publicKey, data)) return end("error")
                a.rtc?.setRemoteAnswer(data.getString("sdp"))
            }
            "ice" -> {
                if (a == null || data.optString("sid") != a.token.sid) return
                a.rtc?.addRemoteIce(
                    data.getString("candidate"),
                    if (data.isNull("sdpMid")) null else data.getString("sdpMid"),
                    if (data.isNull("sdpMLineIndex")) 0 else data.getInt("sdpMLineIndex"),
                )
            }
            "sess.end" -> if (a != null && data.optString("sid") == a.token.sid) end("user")
        }
    }

    private fun rtcListener(a: Active) = object : WebRtcSession.Listener {
        override fun onLocalSdp(type: String, sdp: String) = main.post {
            if (active !== a) return@post
            core.signaling.relay(a.peer.channelId, SessionCrypto.signSdp(a.token.sid, type, sdp, core.identity))
        }.let {}

        override fun onLocalIce(candidate: IceCandidate) = main.post {
            if (active !== a) return@post
            core.signaling.relay(
                a.peer.channelId,
                JSONObject().put("k", "ice").put("sid", a.token.sid).put("candidate", candidate.sdp)
                    .put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex),
            )
        }.let {}

        override fun onData(label: String, msg: JSONObject) {
            if (active === a) a.chat?.onData(label, msg)
        }

        override fun onFileChunk(frame: ByteArray) {
            if (active === a) a.chat?.onFileChunk(frame)
        }

        override fun onControl(msg: JSONObject) {
            if (active === a) ControlAccessibilityService.instance?.handle(msg)
        }

        override fun onConnectionState(state: PeerConnection.PeerConnectionState) = main.post {
            if (active !== a) return@post
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> linkUp(a)
                PeerConnection.PeerConnectionState.DISCONNECTED -> if (a.everConnected) linkDown(a, immediate = false)
                PeerConnection.PeerConnectionState.FAILED -> linkDown(a, immediate = true)
                else -> {}
            }
            core.emitState()
        }.let {}

        override fun onProjectionStopped() = main.post { if (active === a) end("revoked") }.let {}
    }

    companion object {
        private const val TAG = "RcSession"
        private const val CONNECT_TIMEOUT_MS = 90_000L
        private const val FIRST_RETRY_DELAY_MS = 2_000L
        private const val RETRY_INTERVAL_MS = 4_000L
        private const val MIN_RESTART_GAP_MS = 2_500L
        private val DEFAULT_ICE = listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
    }
}
