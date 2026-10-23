package com.remotecontroller.android.core.pairing

import android.os.Handler
import android.os.Looper
import com.remotecontroller.android.core.RcCore
import com.remotecontroller.android.core.crypto.Pairing
import com.remotecontroller.android.core.crypto.Primitives
import com.remotecontroller.android.core.signaling.SignalingClient
import com.remotecontroller.android.core.store.PairedDesktop
import org.json.JSONObject

/**
 * Phone side of pairing. Nothing about this device (not even its public key) is sent until the
 * user has seen the desktop's name, fingerprint and verification code and tapped "Accept".
 */
class PairingManager(private val core: RcCore) : SignalingClient.Listener {
    private val main = Handler(Looper.getMainLooper())

    private class Attempt(
        val code: String,
        val room: String,
        val expectedFingerprint: String?,
        val signalingUrl: String,
        val nonceA: String = Pairing.newNonce(),
        var requested: Boolean = false,
        var offer: Pairing.OfferFields? = null,
        var accept: Pairing.AcceptFields? = null,
    )

    private var attempt: Attempt? = null
    private val timeout = Runnable { fail("Tempo esgotado. Gere um novo código no computador.") }

    init {
        core.signaling.addListener(this)
    }

    /** [input] is either a scanned QR payload (rc1:...) or a typed pairing code. */
    fun start(input: String) {
        cancel()
        val qr = Pairing.decodeQr(input.trim())
        val code = qr?.code ?: Pairing.normalizeCode(input)
        if (code == null) return fail("Código inválido.")
        val url = qr?.signalingUrl ?: core.stores.settings.signalingUrl
        if (url.isBlank()) return fail("Configure o servidor de sinalização ou escaneie o QR code.")
        val a = Attempt(code, Pairing.room(code), qr?.desktopFingerprint, url)
        attempt = a
        core.ensureSignaling(url)
        core.signaling.join(a.room)
        main.postDelayed(timeout, 2 * 60 * 1000L)
        emit("connecting")
    }

    fun confirm(accept: Boolean) {
        val a = attempt ?: return
        val offer = a.offer ?: return
        if (!accept) {
            core.signaling.relay(a.room, JSONObject().put("k", "pair.reject").put("reason", "rejected by user"))
            cancel()
            emit("cancelled")
            return
        }
        val (msg, fields) = Pairing.buildAccept(a.code, offer, core.identity, core.stores.settings.deviceName)
        a.accept = fields
        core.signaling.relay(a.room, msg)
        emit("completing")
    }

    fun cancel() {
        main.removeCallbacks(timeout)
        attempt?.let { core.signaling.leave(it.room) }
        attempt = null
    }

    private fun fail(reason: String) {
        cancel()
        emit("failed", JSONObject().put("reason", reason))
    }

    private fun emit(state: String, extra: JSONObject = JSONObject()) = core.emit("pairing", extra.put("state", state))

    private fun sendRequest(a: Attempt) {
        if (a.requested) return
        a.requested = true
        core.signaling.relay(a.room, JSONObject().put("k", "pair.req").put("nonceA", a.nonceA))
        emit("waiting")
    }

    override fun onMessage(msg: JSONObject) {
        val a = attempt ?: return
        if (msg.optString("room") != a.room) return
        when (msg.optString("t")) {
            "joined" -> {
                val peers = msg.optJSONArray("peers")
                if (peers != null && (0 until peers.length()).any { peers.getString(it) == "desktop" }) sendRequest(a)
                else emit("waiting")
            }
            "peer-joined" -> if (msg.optString("role") == "desktop") sendRequest(a)
            "relay" -> if (msg.optString("from") == "desktop") onRelay(a, msg.getJSONObject("data"))
        }
    }

    private fun onRelay(a: Attempt, data: JSONObject) {
        try {
            when (data.optString("k")) {
                "pair.offer" -> {
                    if (a.offer != null) return
                    val offer = Pairing.verifyOffer(a.code, a.nonceA, data, a.expectedFingerprint)
                        ?: return fail("Não foi possível verificar o computador. O código pode estar errado.")
                    a.offer = offer
                    emit(
                        "confirm",
                        JSONObject()
                            .put("desktopName", offer.desktopName)
                            .put("fingerprint", Primitives.fingerprint(Primitives.fromB64u(offer.desktopPub)))
                            .put("sas", Pairing.sas(offer)),
                    )
                }
                "pair.done" -> {
                    val f = a.accept ?: return
                    if (!Pairing.verifyDone(f, data.getString("sig"))) return fail("Assinatura do computador inválida.")
                    val peer = PairedDesktop(
                        fingerprint = Primitives.fingerprint(Primitives.fromB64u(f.offer.desktopPub)),
                        publicKey = f.offer.desktopPub,
                        name = f.offer.desktopName,
                        channelId = f.channelId,
                        pairedAt = System.currentTimeMillis(),
                    )
                    core.stores.upsertPeer(peer)
                    // Remember the server the desktop told us about, for future sessions.
                    core.stores.settings = core.stores.settings.copy(signalingUrl = a.signalingUrl)
                    cancel()
                    emit("paired", JSONObject().put("peer", peer.toJson()))
                    if (core.available) core.joinEverywhere(peer.channelId)
                    core.emitState()
                }
                "pair.reject" -> fail("O computador cancelou o pareamento.")
            }
        } catch (e: Exception) {
            fail("Mensagem de pareamento inválida.")
        }
    }
}
