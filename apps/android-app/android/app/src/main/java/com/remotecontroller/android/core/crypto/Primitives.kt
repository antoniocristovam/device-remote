package com.remotecontroller.android.core.crypto

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Byte-level primitives shared by pairing and session crypto. Mirrors packages/crypto-proto
 * (encoding.ts / primitives.ts); docs/protocol.md is the reference for both.
 */
object Primitives {
    private val random = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    fun b64u(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun fromB64u(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun fromHex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    /** RFC 5869 HKDF-SHA256. */
    fun hkdfSha256(ikm: ByteArray, salt: String, info: String, length: Int = 32): ByteArray {
        val prk = hmacSha256(salt.toByteArray(Charsets.UTF_8), ikm)
        val out = ByteArrayOutputStream()
        var t = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            t = hmacSha256(prk, t + info.toByteArray(Charsets.UTF_8) + byteArrayOf(counter.toByte()))
            out.write(t)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }

    /** Length-prefixed transcript: u32 big-endian length + bytes per field. Numbers as decimal strings. */
    fun transcript(vararg fields: Any): ByteArray {
        val out = ByteArrayOutputStream()
        for (f in fields) {
            val bytes = when (f) {
                is ByteArray -> f
                is String -> f.toByteArray(Charsets.UTF_8)
                is Long, is Int -> f.toString().toByteArray(Charsets.UTF_8)
                else -> throw IllegalArgumentException("unsupported transcript field ${f::class}")
            }
            out.write(ByteBuffer.allocate(4).putInt(bytes.size).array())
            out.write(bytes)
        }
        return out.toByteArray()
    }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    /** Lowercase hex SHA-256 of an SPKI public key. */
    fun fingerprint(spki: ByteArray): String = hex(sha256(spki))

    fun publicKeyFromSpki(spki: ByteArray): PublicKey =
        KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))

    /** Verifies an ECDSA P-256/SHA-256 signature given in IEEE P1363 (r||s) form. */
    fun verify(spki: ByteArray, data: ByteArray, sigP1363: ByteArray): Boolean = try {
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKeyFromSpki(spki))
            update(data)
            verify(p1363ToDer(sigP1363))
        }
    } catch (e: Exception) {
        false
    }

    // --- ECDSA signature format conversion (Android Keystore speaks DER, WebCrypto speaks P1363) ---

    fun derToP1363(der: ByteArray): ByteArray {
        var i = 2
        if (der[1].toInt() and 0x80 != 0) i += der[1].toInt() and 0x7f
        require(der[i].toInt() == 0x02)
        val rLen = der[i + 1].toInt()
        val r = BigInteger(1, der.copyOfRange(i + 2, i + 2 + rLen))
        i += 2 + rLen
        require(der[i].toInt() == 0x02)
        val sLen = der[i + 1].toInt()
        val s = BigInteger(1, der.copyOfRange(i + 2, i + 2 + sLen))
        return fixed32(r) + fixed32(s)
    }

    fun p1363ToDer(sig: ByteArray): ByteArray {
        require(sig.size == 64) { "P1363 signature must be 64 bytes" }
        val r = derInt(sig.copyOfRange(0, 32))
        val s = derInt(sig.copyOfRange(32, 64))
        val body = byteArrayOf(0x02, r.size.toByte()) + r + byteArrayOf(0x02, s.size.toByte()) + s
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    private fun derInt(fixed: ByteArray): ByteArray {
        var start = 0
        while (start < fixed.size - 1 && fixed[start] == 0.toByte()) start++
        val trimmed = fixed.copyOfRange(start, fixed.size)
        return if (trimmed[0].toInt() and 0x80 != 0) byteArrayOf(0) + trimmed else trimmed
    }
}

/** Signs with the device identity key; output is P1363. */
interface Signer {
    val publicKey: ByteArray
    fun sign(data: ByteArray): ByteArray
}
