package com.remotecontroller.android.rn

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.remotecontroller.android.core.RcCore
import com.remotecontroller.android.core.session.Notifications
import org.json.JSONArray
import org.json.JSONObject

class RcModule(private val ctx: ReactApplicationContext) : NativeRcModuleSpec(ctx), ActivityEventListener {
    private val core = RcCore.get(ctx)
    private val sink: (String, JSONObject) -> Unit = { type, payload ->
        if (ctx.hasActiveReactInstance()) {
            ctx.emitDeviceEvent(EVENT, JSONObject().put("type", type).put("payload", payload).toString())
        }
    }

    init {
        core.addSink(sink)
        ctx.addActivityEventListener(this)
        Notifications.ensureChannels(ctx)
    }

    override fun invalidate() {
        core.removeSink(sink)
        ctx.removeActivityEventListener(this)
        super.invalidate()
    }

    override fun getName() = NAME

    override fun getState(promise: Promise) = promise.resolve(core.state().toString())

    override fun getHistory(promise: Promise) =
        promise.resolve(JSONArray(core.stores.sessions().map { it.toJson() }).toString())

    /** Google code scanner: the camera UI runs in Play Services, so the app needs no camera permission. */
    override fun scanQr(promise: Promise) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        val activity = ctx.currentActivity
        val scanner = if (activity != null) GmsBarcodeScanning.getClient(activity, options) else GmsBarcodeScanning.getClient(ctx, options)
        scanner.startScan()
            .addOnSuccessListener { promise.resolve(it.rawValue ?: "") }
            .addOnCanceledListener { promise.reject("cancelled", "Leitura cancelada") }
            .addOnFailureListener { promise.reject("scan_failed", it.message ?: "Falha ao ler o QR code", it) }
    }

    override fun startPairing(input: String) = core.pairing.start(input)
    override fun confirmPairing(accept: Boolean) = core.pairing.confirm(accept)
    override fun cancelPairing() = core.pairing.cancel()
    override fun setAvailable(on: Boolean) = core.setAvailable(on)
    override fun endSession() = core.sessions.end("revoked")
    override fun removePeer(fingerprint: String) = core.removePeer(fingerprint)

    override fun saveSettings(json: String) {
        val o = JSONObject(json)
        val cur = core.stores.settings
        core.stores.settings = cur.copy(
            signalingUrl = o.optString("signalingUrl", cur.signalingUrl).trim(),
            deviceName = o.optString("deviceName", cur.deviceName).trim().ifEmpty { cur.deviceName },
        )
        if (core.available) core.ensureSignaling()
        core.emitState()
    }

    override fun getChat(fingerprint: String, promise: Promise) =
        promise.resolve(JSONArray(core.stores.chat(fingerprint)).toString())

    override fun getTransfers(promise: Promise) =
        promise.resolve((core.sessions.active?.chat?.transfersJson() ?: JSONArray()).toString())

    override fun sendChat(text: String, promise: Promise) =
        promise.resolve(core.sessions.active?.chat?.sendText(text) ?: false)

    /** System document picker; chosen files are offered to the connected desktop. */
    override fun pickFiles() {
        val activity = ctx.currentActivity ?: return
        if (core.sessions.active == null) return
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        activity.startActivityForResult(intent, REQ_PICK)
    }

    override fun cancelTransfer(id: String) {
        core.sessions.active?.chat?.cancel(id)
    }

    override fun openFile(uri: String) {
        val activity = ctx.currentActivity ?: return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { activity.startActivity(Intent.createChooser(intent, null)) }
    }

    override fun openAccessibilitySettings() {
        val activity = ctx.currentActivity ?: return
        activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    /** Accepting = the in-app consent tap, followed by Android's own screen-capture consent dialog. */
    override fun respondSession(accept: Boolean) {
        if (!accept) return core.sessions.deny()
        val activity = ctx.currentActivity ?: return core.sessions.deny("app not in foreground")
        val mpm = activity.getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= 34) {
            // Remote control needs the whole screen, not a single app.
            mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            mpm.createScreenCaptureIntent()
        }
        activity.startActivityForResult(intent, REQ_PROJECTION)
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_PICK) {
            if (resultCode != Activity.RESULT_OK || data == null) return
            val uris = data.clipData?.let { c -> (0 until c.itemCount).map { c.getItemAt(it).uri } } ?: listOfNotNull(data.data)
            core.sessions.active?.chat?.sendUris(uris)
            return
        }
        if (requestCode != REQ_PROJECTION) return
        if (resultCode == Activity.RESULT_OK && data != null) core.sessions.acceptWithProjection(resultCode, data)
        else core.sessions.deny("screen capture refused")
    }

    override fun onNewIntent(intent: Intent) {}

    companion object {
        const val NAME = "RcModule"
        const val EVENT = "rc"
        private const val REQ_PROJECTION = 4711
        private const val REQ_PICK = 4712
    }
}
