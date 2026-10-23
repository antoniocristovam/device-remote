package com.remotecontroller.android.core

import android.content.Context
import com.remotecontroller.android.core.crypto.IdentityKeystore
import com.remotecontroller.android.core.input.ControlAccessibilityService
import com.remotecontroller.android.core.pairing.PairingManager
import com.remotecontroller.android.core.session.SessionCoordinator
import com.remotecontroller.android.core.signaling.SignalingClient
import com.remotecontroller.android.core.store.Stores
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Process-wide wiring of identity, storage, signaling, pairing and sessions. The React Native
 * layer and the foreground service both talk to this object; it outlives either of them.
 */
class RcCore private constructor(val app: Context) {
    val identity = IdentityKeystore(app)
    val stores = Stores(app)
    val signaling = SignalingClient()
    val pairing = PairingManager(this)
    val sessions = SessionCoordinator(this)

    /** "Available" = listening for connection requests from paired desktops (only while the user enables it). */
    var available = false
        private set

    private val sinks = CopyOnWriteArrayList<(String, JSONObject) -> Unit>()

    init {
        signaling.addListener(object : SignalingClient.Listener {
            override fun onStatus(status: SignalingClient.Status) = emitState()
        })
    }

    val sessionActive: Boolean get() = sessions.active != null

    fun addSink(sink: (String, JSONObject) -> Unit) = sinks.add(sink)
    fun removeSink(sink: (String, JSONObject) -> Unit) = sinks.remove(sink)

    fun emit(type: String, payload: JSONObject = JSONObject()) = sinks.forEach { it(type, payload) }

    fun ensureSignaling(url: String = stores.settings.signalingUrl): Boolean {
        if (url.isBlank()) return false
        signaling.start(url)
        return true
    }

    fun setAvailable(on: Boolean) {
        available = on
        if (on) {
            ensureSignaling()
            stores.peers().forEach { signaling.join(it.channelId) }
        } else if (!sessionActive) {
            stores.peers().forEach { signaling.leave(it.channelId) }
        }
        emitState()
    }

    /** Instantly forgets a desktop; an active session with it is torn down first. */
    fun removePeer(fingerprint: String) {
        val peer = stores.peer(fingerprint) ?: return
        if (sessions.active?.peer?.fingerprint == fingerprint) sessions.end("revoked")
        signaling.leave(peer.channelId)
        stores.removePeer(fingerprint)
        stores.clearChat(fingerprint)
        emitState()
    }

    fun onAccessibilityChanged() = emitState()

    fun state(): JSONObject = JSONObject()
        .put("identity", JSONObject().put("fingerprint", identity.fingerprint).put("name", stores.settings.deviceName))
        .put("settings", stores.settings.toJson())
        .put("signaling", signaling.status.name.lowercase())
        .put("available", available)
        .put("accessibility", ControlAccessibilityService.isEnabled(app))
        .put("peers", JSONArray(stores.peers().map { it.toJson() }))
        .put("session", sessions.stateJson())

    fun emitState() = emit("state", state())

    companion object {
        @Volatile
        private var instance: RcCore? = null

        fun get(context: Context): RcCore =
            instance ?: synchronized(this) { instance ?: RcCore(context.applicationContext).also { instance = it } }

        fun peek(): RcCore? = instance
    }
}
