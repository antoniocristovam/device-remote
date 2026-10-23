package com.remotecontroller.android.core.crypto

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Checks the Kotlin protocol code against vectors produced by the TypeScript reference
 * (scripts/gen-test-vectors.mjs), and writes Kotlin-signed messages for the reverse check
 * (scripts/verify-android-vectors.mjs).
 */
class InteropTest {
    private val v = JSONObject(javaClass.classLoader!!.getResource("vectors.json")!!.readText())

    private class SoftwareSigner : Signer {
        private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        override val publicKey: ByteArray = pair.public.encoded
        override fun sign(data: ByteArray): ByteArray = Primitives.derToP1363(
            Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private)
                update(data)
                sign()
            },
        )
    }

    @Test
    fun transcriptAndDerivationsMatch() {
        assertEquals(v.getString("transcriptHex"), Primitives.hex(Primitives.transcript("ab", "c", 42)))
        assertEquals(v.getString("room"), Pairing.room(v.getString("code")))
        assertEquals(v.getString("keyHex"), Primitives.hex(Pairing.key(v.getString("code"))))
    }

    @Test
    fun qrDecodes() {
        val qr = Pairing.decodeQr(v.getString("qr"))!!
        assertEquals("ws://192.168.0.10:8787", qr.signalingUrl)
        assertEquals(v.getString("code"), qr.code)
        assertEquals(v.getString("desktopFp"), qr.desktopFingerprint)
        assertNull(Pairing.decodeQr("https://example.com"))
        assertEquals("0000111111110000", Pairing.normalizeCode("oooo-iiii-llll-0000"))
    }

    @Test
    fun verifiesTypescriptOfferAndSas() {
        val offer = Pairing.verifyOffer(v.getString("code"), v.getString("nonceA"), v.getJSONObject("offer"), v.getString("desktopFp"))
        assertNotNull(offer)
        assertEquals(v.getString("sas"), Pairing.sas(offer!!))
        assertNull(Pairing.verifyOffer("ZZZZZZZZZZZZZZZZ", v.getString("nonceA"), v.getJSONObject("offer"), null))
        assertNull(Pairing.verifyOffer(v.getString("code"), v.getString("nonceA"), v.getJSONObject("offer"), "00".repeat(32)))
    }

    @Test
    fun verifiesTypescriptSessionMessages() {
        val ch = v.getString("channelId")
        val pub = v.getString("desktopPub")
        val now = v.getLong("sessReqNow")
        assertTrue(SessionCrypto.verifyRequest(ch, pub, v.getJSONObject("sessReq"), now))
        assertFalse(SessionCrypto.verifyRequest(ch, pub, v.getJSONObject("sessReq"), now + 10 * 60 * 1000))
        assertTrue(SessionCrypto.verifySdp(pub, v.getJSONObject("sdpMsg")))
        val tampered = JSONObject(v.getJSONObject("sdpMsg").toString()).put("sdp", "v=0\r\na=fingerprint:sha-256 00:00\r\n")
        assertFalse(SessionCrypto.verifySdp(pub, tampered))
        assertTrue(SessionCrypto.verifyResume(ch, pub, "sid-1", v.getJSONObject("resume"), now))
        assertFalse(SessionCrypto.verifyResume(ch, pub, "other", v.getJSONObject("resume"), now))
    }

    @Test
    fun signatureFormatRoundTrips() {
        val s = SoftwareSigner()
        val data = "hello".toByteArray()
        val sig = s.sign(data)
        assertEquals(64, sig.size)
        assertTrue(Primitives.verify(s.publicKey, data, sig))
        assertFalse(Primitives.verify(s.publicKey, "other".toByteArray(), sig))
    }

    /** Produces Kotlin-signed pairing/session messages for the TypeScript side to verify. */
    @Test
    fun writesAndroidVectors() {
        val android = SoftwareSigner()
        val offer = Pairing.verifyOffer(v.getString("code"), v.getString("nonceA"), v.getJSONObject("offer"), null)!!
        val (accept, _) = Pairing.buildAccept(v.getString("code"), offer, android, "Pixel Test")
        val nonceD = v.getJSONObject("sessReq").getString("nonceD")
        val (sessAccept, token) = SessionCrypto.buildAccept(
            v.getString("channelId"), nonceD, v.getString("desktopFp"), Primitives.fingerprint(android.publicKey), android,
        )
        val sdp = SessionCrypto.signSdp(token.sid, "offer", "v=0\r\na=fingerprint:sha-256 12:34\r\n", android)
        val out = JSONObject()
            .put("accept", accept)
            .put("androidPub", Primitives.b64u(android.publicKey))
            .put("androidFp", Primitives.fingerprint(android.publicKey))
            .put("sessAccept", sessAccept)
            .put("nonceD", nonceD)
            .put("sdp", sdp)
        File("build/interop").apply { mkdirs() }.resolve("android-vectors.json").writeText(out.toString(2))
    }
}
