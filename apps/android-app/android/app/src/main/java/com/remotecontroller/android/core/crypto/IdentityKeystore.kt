package com.remotecontroller.android.core.crypto

import android.content.pm.PackageManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Device identity: a non-exportable ECDSA P-256 key in the Android Keystore (StrongBox when the
 * hardware has it). The private key never exists in app memory or on disk in plain form.
 */
class IdentityKeystore(private val context: Context) : Signer {
    private val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    init {
        if (!keyStore.containsAlias(ALIAS)) generate()
    }

    override val publicKey: ByteArray
        get() = keyStore.getCertificate(ALIAS).publicKey.encoded

    val fingerprint: String
        get() = Primitives.fingerprint(publicKey)

    override fun sign(data: ByteArray): ByteArray {
        val key = keyStore.getKey(ALIAS, null) as PrivateKey
        val der = Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(data)
            sign()
        }
        return Primitives.derToP1363(der)
    }

    private fun generate() {
        val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        try {
            generate(strongBox)
        } catch (e: Exception) {
            if (strongBox && (e is StrongBoxUnavailableException || e.cause is StrongBoxUnavailableException)) generate(false)
            else throw e
        }
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).run {
            initialize(spec)
            generateKeyPair()
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "rc_identity_v1"
    }
}
