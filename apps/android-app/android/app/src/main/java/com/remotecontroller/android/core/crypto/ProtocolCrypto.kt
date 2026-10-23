package com.remotecontroller.android.core.crypto

import com.remotecontroller.android.core.crypto.Primitives.b64u
import com.remotecontroller.android.core.crypto.Primitives.fromB64u
import com.remotecontroller.android.core.crypto.Primitives.hex
import com.remotecontroller.android.core.crypto.Primitives.transcript
import org.json.JSONObject

/** Android side of the pairing handshake. Mirrors packages/crypto-proto/src/pairing.ts. */
object Pairing {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val CODE_LENGTH = 16

    data class QrPayload(val signalingUrl: String, val code: String, val desktopFingerprint: String, val desktopName: String)

    data class OfferFields(val nonceA: String, val nonceD: String, val desktopPub: String, val desktopName: String)

    data class AcceptFields(
        val offer: OfferFields,
        val androidPub: String,
        val androidName: String,
        val channelId: String,
    )

    fun normalizeCode(input: String): String? {
        val s = input.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace('I', '1').replace('L', '1')
        if (s.length != CODE_LENGTH || s.any { it !in ALPHABET }) return null
        return s
    }

    fun decodeQr(text: String): QrPayload? {
        if (!text.startsWith("rc1:")) return null
        return try {
            val o = JSONObject(String(fromB64u(text.substring(4)), Charsets.UTF_8))
            val code = normalizeCode(o.getString("c")) ?: return null
            QrPayload(o.getString("s"), code, o.getString("f"), o.getString("n"))
        } catch (e: Exception) {
            null
        }
    }

    fun room(code: String): String = hex(Primitives.sha256(transcript("rc/pair-room/v1", code))).substring(0, 32)

    fun key(code: String): ByteArray = Primitives.hkdfSha256(code.toByteArray(Charsets.UTF_8), "rc/pair/v1", "mac-key")

    private fun offerData(f: OfferFields) = transcript("rc/pair-offer/v1", f.nonceA, f.nonceD, f.desktopPub, f.desktopName)

    private fun acceptData(f: AcceptFields) = transcript(
        "rc/pair-accept/v1", f.offer.nonceA, f.offer.nonceD, f.offer.desktopPub, f.offer.desktopName,
        f.androidPub, f.androidName, f.channelId,
    )

    fun sigData(role: String, f: AcceptFields) = transcript(
        "rc/pair-sig/v1", role, f.offer.nonceA, f.offer.nonceD, f.offer.desktopPub, f.offer.desktopName,
        f.androidPub, f.androidName, f.channelId,
    )

    fun sas(f: OfferFields): String {
        val h = Primitives.sha256(transcript("rc/sas/v1", f.nonceA, f.nonceD, f.desktopPub))
        val n = ((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or
            ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)
        return (n % 1_000_000).toString().padStart(6, '0')
    }

    fun newNonce(): String = b64u(Primitives.randomBytes(16))

    /** Returns the verified offer, or null if the MAC (or the QR fingerprint, when known) does not match. */
    fun verifyOffer(code: String, nonceA: String, offer: JSONObject, expectedFingerprint: String?): OfferFields? {
        val f = OfferFields(nonceA, offer.getString("nonceD"), offer.getString("desktopPub"), offer.getString("desktopName"))
        val mac = Primitives.hmacSha256(key(code), offerData(f))
        if (!Primitives.constantTimeEquals(mac, fromB64u(offer.getString("mac")))) return null
        if (expectedFingerprint != null && Primitives.fingerprint(fromB64u(f.desktopPub)) != expectedFingerprint) return null
        return f
    }

    fun buildAccept(code: String, offer: OfferFields, signer: Signer, androidName: String): Pair<JSONObject, AcceptFields> {
        val f = AcceptFields(offer, b64u(signer.publicKey), androidName, hex(Primitives.randomBytes(16)))
        val msg = JSONObject()
            .put("k", "pair.accept")
            .put("androidPub", f.androidPub)
            .put("androidName", androidName)
            .put("channelId", f.channelId)
            .put("mac", b64u(Primitives.hmacSha256(key(code), acceptData(f))))
            .put("sig", b64u(signer.sign(sigData("android", f))))
        return msg to f
    }

    fun verifyDone(f: AcceptFields, sig: String): Boolean =
        Primitives.verify(fromB64u(f.offer.desktopPub), sigData("desktop", f), fromB64u(sig))
}

/** Android side of the session handshake. Mirrors packages/crypto-proto/src/session.ts. */
object SessionCrypto {
    const val MAX_CLOCK_SKEW_MS = 2 * 60 * 1000L
    const val SESSION_TTL_MS = 12 * 60 * 60 * 1000L

    data class Token(val sid: String, val desktopFp: String, val androidFp: String, val iat: Long, val exp: Long) {
        fun toJson(): JSONObject = JSONObject()
            .put("sid", sid).put("desktopFp", desktopFp).put("androidFp", androidFp).put("iat", iat).put("exp", exp)
    }

    private fun withinSkew(ts: Long, now: Long) = kotlin.math.abs(now - ts) <= MAX_CLOCK_SKEW_MS

    fun verifyRequest(channelId: String, desktopPub: String, msg: JSONObject, now: Long = System.currentTimeMillis()): Boolean {
        val ts = msg.getLong("ts")
        if (!withinSkew(ts, now)) return false
        return Primitives.verify(
            fromB64u(desktopPub),
            transcript("rc/sess-req/v1", channelId, msg.getString("nonceD"), ts),
            fromB64u(msg.getString("sig")),
        )
    }

    fun buildAccept(
        channelId: String,
        nonceD: String,
        desktopFp: String,
        androidFp: String,
        signer: Signer,
        now: Long = System.currentTimeMillis(),
    ): Pair<JSONObject, Token> {
        val token = Token(hex(Primitives.randomBytes(16)), desktopFp, androidFp, now, now + SESSION_TTL_MS)
        val nonceA = Pairing.newNonce()
        val data = transcript(
            "rc/sess-accept/v1", channelId, nonceD, nonceA, token.sid, token.desktopFp, token.androidFp, token.iat, token.exp,
        )
        val msg = JSONObject()
            .put("k", "sess.accept")
            .put("token", token.toJson())
            .put("nonceA", nonceA)
            .put("sig", b64u(signer.sign(data)))
        return msg to token
    }

    fun verifyResume(channelId: String, desktopPub: String, activeSid: String, msg: JSONObject, now: Long = System.currentTimeMillis()): Boolean {
        val sid = msg.getString("sid")
        val ts = msg.getLong("ts")
        if (sid != activeSid || !withinSkew(ts, now)) return false
        return Primitives.verify(
            fromB64u(desktopPub),
            transcript("rc/sess-resume/v1", channelId, sid, msg.getString("nonceD"), ts),
            fromB64u(msg.getString("sig")),
        )
    }

    fun dtlsFingerprints(sdp: String): String {
        val re = Regex("^a=fingerprint:(\\S+)\\s+(\\S+)", RegexOption.IGNORE_CASE)
        return sdp.split(Regex("\\r?\\n"))
            .mapNotNull { re.find(it.trim()) }
            .map { "${it.groupValues[1].lowercase()} ${it.groupValues[2].lowercase()}" }
            .toSortedSet()
            .joinToString("\n")
    }

    private fun sdpSigData(sid: String, role: String, type: String, fps: String) = transcript("rc/sdp/v1", sid, role, type, fps)

    fun signSdp(sid: String, type: String, sdp: String, signer: Signer): JSONObject {
        val fps = dtlsFingerprints(sdp)
        require(fps.isNotEmpty()) { "SDP has no DTLS fingerprint" }
        return JSONObject()
            .put("k", "sdp").put("sid", sid).put("type", type).put("sdp", sdp)
            .put("sig", b64u(signer.sign(sdpSigData(sid, "android", type, fps))))
    }

    fun verifySdp(desktopPub: String, msg: JSONObject): Boolean {
        val fps = dtlsFingerprints(msg.getString("sdp"))
        if (fps.isEmpty()) return false
        return Primitives.verify(
            fromB64u(desktopPub),
            sdpSigData(msg.getString("sid"), "desktop", msg.getString("type"), fps),
            fromB64u(msg.getString("sig")),
        )
    }
}
