package com.remotecontroller.android.core.session

import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import com.remotecontroller.android.core.RcCore
import com.remotecontroller.android.core.crypto.Primitives
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Chat and file transfer for one session, over the "chat" and "file" data channels.
 * Protocol: packages/protocol/src/channels.ts (ChatFrame / FileFrame). Received files go to
 * Downloads/Remote Controller and are never opened automatically.
 */
class ChatTransfers(private val core: RcCore, private val peerFingerprint: String, private val rtc: () -> WebRtcSession?) {
    private val main = Handler(Looper.getMainLooper())
    private val inbound = Executors.newSingleThreadExecutor { Thread(it, "rc-files-in") }
    private val outbound = Executors.newCachedThreadPool { Thread(it, "rc-files-out") }

    private class Incoming(val name: String, val size: Long, val uri: Uri?, val file: File?, val out: OutputStream) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var received = 0L
    }

    private class Outgoing(val name: String, val size: Long) {
        @Volatile var cancelled = false
        @Volatile var answer: JSONObject? = null
        var latch = CountDownLatch(1)
        var sent = 0L
        var state = "waiting"
    }

    private val incoming = ConcurrentHashMap<String, Incoming>()
    private val outgoing = ConcurrentHashMap<String, Outgoing>()
    private var transfersDirty = false

    private fun runIn(executor: java.util.concurrent.ExecutorService, task: () -> Unit) {
        if (!executor.isShutdown) runCatching { executor.execute(task) }
    }

    // ---------------- Chat ----------------

    fun sendText(text: String): Boolean {
        val t = text.trim().take(8000)
        if (t.isEmpty()) return false
        val id = Primitives.hex(Primitives.randomBytes(12))
        val ts = System.currentTimeMillis()
        if (rtc()?.sendJson("chat", JSONObject().put("t", "msg").put("id", id).put("text", t).put("ts", ts)) != true) return false
        record(JSONObject().put("kind", "msg").put("id", id).put("from", "me").put("text", t).put("ts", ts))
        return true
    }

    fun onData(label: String, msg: JSONObject) {
        if (label == "chat") onChat(msg) else onFileFrame(msg)
    }

    private fun onChat(msg: JSONObject) {
        val id = msg.optString("id").take(64)
        when (msg.optString("t")) {
            "msg" -> {
                val text = msg.optString("text").take(8000)
                if (id.isEmpty() || text.isEmpty()) return
                record(JSONObject().put("kind", "msg").put("id", id).put("from", "peer").put("text", text).put("ts", msg.optLong("ts")))
                rtc()?.sendJson("chat", JSONObject().put("t", "ack").put("id", id))
            }
            "ack" -> {
                core.stores.markDelivered(peerFingerprint, id)
                core.stores.chat(peerFingerprint).firstOrNull { it.optString("id") == id }?.let { emitEntry(it) }
            }
        }
    }

    private fun record(entry: JSONObject) {
        core.stores.putChat(peerFingerprint, entry)
        emitEntry(entry)
    }

    private fun emitEntry(entry: JSONObject) =
        main.post { core.emit("chatEntry", JSONObject().put("peer", peerFingerprint).put("entry", entry)) }

    // ---------------- Receiving files ----------------

    private fun onFileFrame(msg: JSONObject) {
        val id = msg.optString("id")
        if (!ID.matches(id)) return
        when (msg.optString("t")) {
            "offer" -> runIn(inbound) { beginIncoming(id, msg) }
            "done" -> runIn(inbound) { finishIncoming(id, msg.optString("sha256")) }
            "cancel" -> {
                runIn(inbound) { abortIncoming(id, record = true) }
                outgoing[id]?.let { it.answer = msg; it.latch.countDown() }
            }
            // accept / reject / ack answer one of our own transfers.
            else -> outgoing[id]?.let { it.answer = msg; it.latch.countDown() }
        }
    }

    fun onFileChunk(frame: ByteArray) {
        if (frame.size <= 16) return
        val id = Primitives.hex(frame.copyOfRange(0, 16))
        runIn(inbound) {
            val f = incoming[id] ?: return@runIn
            val len = frame.size - 16
            f.received += len
            if (f.received > f.size) {
                abortIncoming(id, record = true)
                rtc()?.sendJson("file", JSONObject().put("t", "cancel").put("id", id).put("reason", "size exceeded"))
                return@runIn
            }
            f.digest.update(frame, 16, len)
            f.out.write(frame, 16, len)
            markTransfersDirty()
        }
    }

    private fun beginIncoming(id: String, msg: JSONObject) {
        val size = msg.optLong("size", -1)
        val name = safeFileName(msg.optString("name"))
        if (size < 0 || size > MAX_FILE_BYTES || incoming.containsKey(id)) {
            rtc()?.sendJson("file", JSONObject().put("t", "reject").put("id", id).put("reason", "too large"))
            return
        }
        try {
            val f = openDestination(name, msg.optString("mime").ifEmpty { "application/octet-stream" }, size)
            incoming[id] = f
            rtc()?.sendJson("file", JSONObject().put("t", "accept").put("id", id))
            markTransfersDirty()
        } catch (e: Exception) {
            Log.w(TAG, "cannot store incoming file", e)
            rtc()?.sendJson("file", JSONObject().put("t", "reject").put("id", id).put("reason", "storage unavailable"))
        }
    }

    private fun openDestination(name: String, mime: String, size: Long): Incoming {
        val resolver = core.app.contentResolver
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Remote Controller")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("insert failed")
            return Incoming(name, size, uri, null, resolver.openOutputStream(uri) ?: error("open failed"))
        }
        val dir = File(core.app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Remote Controller").apply { mkdirs() }
        var file = File(dir, name)
        var i = 1
        while (file.exists()) file = File(dir, "${name.substringBeforeLast('.')} (${i++})${if ('.' in name) "." + name.substringAfterLast('.') else ""}")
        return Incoming(name, size, null, file, file.outputStream())
    }

    private fun finishIncoming(id: String, sha256: String) {
        val f = incoming.remove(id) ?: return
        runCatching { f.out.close() }
        val ok = f.received == f.size && Primitives.hex(f.digest.digest()) == sha256
        val resolver = core.app.contentResolver
        if (ok) {
            if (f.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                resolver.update(f.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            }
        } else {
            f.uri?.let { runCatching { resolver.delete(it, null, null) } }
            f.file?.delete()
        }
        rtc()?.sendJson("file", JSONObject().put("t", "ack").put("id", id).put("ok", ok))
        val entry = fileEntry(id, "peer", f.name, f.size, ok)
        if (ok) entry.put("uri", (f.uri ?: f.file?.let { Uri.fromFile(it) }).toString())
        record(entry)
        markTransfersDirty()
    }

    private fun abortIncoming(id: String, record: Boolean) {
        val f = incoming.remove(id) ?: return
        runCatching { f.out.close() }
        f.uri?.let { runCatching { core.app.contentResolver.delete(it, null, null) } }
        f.file?.delete()
        if (record) record(fileEntry(id, "peer", f.name, f.size, false))
        markTransfersDirty()
    }

    // ---------------- Sending files ----------------

    fun sendUris(uris: List<Uri>) = uris.forEach { uri -> runIn(outbound) { sendUri(uri) } }

    private fun sendUri(uri: Uri) {
        val resolver = core.app.contentResolver
        var name = "arquivo"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0) ?: name
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        if (size < 0 || size > MAX_FILE_BYTES) return
        val id = Primitives.hex(Primitives.randomBytes(16))
        val o = Outgoing(name, size)
        outgoing[id] = o
        markTransfersDirty()
        var ok = false
        try {
            val r = rtc() ?: return
            val offer = JSONObject().put("t", "offer").put("id", id).put("name", name).put("size", size)
                .put("mime", resolver.getType(uri) ?: "application/octet-stream")
            if (!r.sendJson("file", offer)) return
            if (!o.latch.await(30, TimeUnit.SECONDS) || o.answer?.optString("t") != "accept") return

            o.state = "sending"
            val digest = MessageDigest.getInstance("SHA-256")
            val header = Primitives.fromHex(id)
            val buf = ByteArray(PAYLOAD)
            resolver.openInputStream(uri)?.use { input ->
                while (true) {
                    if (o.cancelled) {
                        r.sendJson("file", JSONObject().put("t", "cancel").put("id", id).put("reason", "sender stopped"))
                        return
                    }
                    val n = input.readFully(buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                    r.sendFileFrame(header + buf.copyOf(n))
                    o.sent += n
                    markTransfersDirty()
                }
            } ?: return

            o.state = "verifying"
            o.answer = null
            o.latch = CountDownLatch(1)
            r.sendJson("file", JSONObject().put("t", "done").put("id", id).put("sha256", Primitives.hex(digest.digest())))
            ok = o.latch.await(120, TimeUnit.SECONDS) && o.answer?.optString("t") == "ack" && o.answer?.optBoolean("ok") == true
        } catch (e: Exception) {
            Log.w(TAG, "send failed", e)
        } finally {
            outgoing.remove(id)
            record(fileEntry(id, "me", name, size, ok))
            markTransfersDirty()
        }
    }

    /** Fills [buf] as far as possible; returns the number of bytes read (0 at end of stream). */
    private fun java.io.InputStream.readFully(buf: ByteArray): Int {
        var off = 0
        while (off < buf.size) {
            val n = read(buf, off, buf.size - off)
            if (n < 0) break
            off += n
        }
        return off
    }

    fun cancel(id: String) {
        outgoing[id]?.let {
            it.cancelled = true
            it.answer = JSONObject().put("t", "cancel")
            it.latch.countDown()
        }
        if (incoming.containsKey(id)) runIn(inbound) {
            abortIncoming(id, record = true)
            rtc()?.sendJson("file", JSONObject().put("t", "cancel").put("id", id).put("reason", "receiver cancelled"))
        }
    }

    // ---------------- Progress to the UI ----------------

    fun transfersJson(): JSONArray {
        val arr = JSONArray()
        incoming.forEach { (id, f) ->
            arr.put(JSONObject().put("id", id).put("from", "peer").put("name", f.name).put("size", f.size).put("bytes", f.received).put("state", "receiving"))
        }
        outgoing.forEach { (id, o) ->
            arr.put(JSONObject().put("id", id).put("from", "me").put("name", o.name).put("size", o.size).put("bytes", o.sent).put("state", o.state))
        }
        return arr
    }

    /** Coalesces progress events to at most ~4 per second. */
    private fun markTransfersDirty() {
        synchronized(this) {
            if (transfersDirty) return
            transfersDirty = true
        }
        main.postDelayed({
            synchronized(this) { transfersDirty = false }
            core.emit("transfers", JSONObject().put("peer", peerFingerprint).put("list", transfersJson()))
        }, 250)
    }

    fun close() {
        outgoing.values.forEach { it.cancelled = true; it.latch.countDown() }
        runIn(inbound) { incoming.keys.toList().forEach { abortIncoming(it, record = true) } }
        inbound.shutdown()
        outbound.shutdown()
    }

    private fun fileEntry(id: String, from: String, name: String, size: Long, ok: Boolean) = JSONObject()
        .put("kind", "file").put("id", id).put("from", from).put("name", name).put("size", size)
        .put("ts", System.currentTimeMillis()).put("ok", ok)

    companion object {
        private const val TAG = "RcFiles"
        private const val FRAME_BYTES = 16 * 1024
        private const val PAYLOAD = FRAME_BYTES - 16
        const val MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024
        private val ID = Regex("^[a-f0-9]{32}$")

        /** Mirrors safeFileName() in packages/protocol. */
        fun safeFileName(name: String): String {
            var n = name.split('/', '\\').last()
            n = n.replace(Regex("[\\u0000-\\u001f<>:\"|?*\\u007f]"), "_").replace(Regex("^[.\\s]+"), "").replace(Regex("[.\\s]+$"), "")
            if (Regex("^(con|prn|aux|nul|com\\d|lpt\\d)(\\..*)?$", RegexOption.IGNORE_CASE).matches(n)) n = "_$n"
            return n.take(200).ifEmpty { "arquivo" }
        }
    }
}
