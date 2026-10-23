package com.remotecontroller.android.core.store

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** A paired desktop. Only public material: the identity key lives in the Keystore. */
data class PairedDesktop(
    val fingerprint: String,
    val publicKey: String,
    val name: String,
    val channelId: String,
    val pairedAt: Long,
    val lastSeenAt: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("fingerprint", fingerprint).put("publicKey", publicKey).put("name", name)
        .put("channelId", channelId).put("pairedAt", pairedAt).put("lastSeenAt", lastSeenAt ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject) = PairedDesktop(
            o.getString("fingerprint"), o.getString("publicKey"), o.getString("name"), o.getString("channelId"),
            o.getLong("pairedAt"), if (o.isNull("lastSeenAt")) null else o.getLong("lastSeenAt"),
        )
    }
}

data class SessionLogEntry(
    val sid: String,
    val peerFingerprint: String,
    val peerName: String,
    val startedAt: Long,
    val endedAt: Long? = null,
    val endReason: String? = null,
    val reconnects: Int = 0,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("sid", sid).put("peerFingerprint", peerFingerprint).put("peerName", peerName).put("startedAt", startedAt)
        .put("endedAt", endedAt ?: JSONObject.NULL).put("endReason", endReason ?: JSONObject.NULL)
            .put("reconnects", reconnects)

    companion object {
        fun fromJson(o: JSONObject) = SessionLogEntry(
            o.getString("sid"), o.getString("peerFingerprint"), o.getString("peerName"), o.getLong("startedAt"),
            if (o.isNull("endedAt")) null else o.getLong("endedAt"),
            if (o.isNull("endReason")) null else o.getString("endReason"),
            o.optInt("reconnects", 0),
        )
    }
}

data class Settings(val signalingUrl: String, val deviceName: String) {
    fun toJson(): JSONObject = JSONObject().put("signalingUrl", signalingUrl).put("deviceName", deviceName)
}

/** Small JSON files in app-private storage, written atomically. */
class Stores(context: Context) {
    private val dir = context.filesDir
    private val prefs = context.getSharedPreferences("rc_settings", Context.MODE_PRIVATE)

    @Synchronized
    fun peers(): List<PairedDesktop> = readArray("peers.json").map { PairedDesktop.fromJson(it) }

    fun peer(fingerprint: String) = peers().firstOrNull { it.fingerprint == fingerprint }

    fun peerByChannel(channelId: String) = peers().firstOrNull { it.channelId == channelId }

    @Synchronized
    fun upsertPeer(p: PairedDesktop) = writeArray("peers.json", peers().filter { it.fingerprint != p.fingerprint }.plus(p).map { it.toJson() })

    @Synchronized
    fun touchPeer(fingerprint: String) =
        writeArray("peers.json", peers().map { if (it.fingerprint == fingerprint) it.copy(lastSeenAt = System.currentTimeMillis()) else it }.map { it.toJson() })

    @Synchronized
    fun removePeer(fingerprint: String) = writeArray("peers.json", peers().filter { it.fingerprint != fingerprint }.map { it.toJson() })

    @Synchronized
    fun sessions(): List<SessionLogEntry> = readArray("sessions.json").map { SessionLogEntry.fromJson(it) }.sortedByDescending { it.startedAt }

    @Synchronized
    fun logSessionStart(e: SessionLogEntry) = writeArray("sessions.json", (sessions().reversed() + e).takeLast(500).map { it.toJson() })

    @Synchronized
    fun logSessionEnd(sid: String, reason: String, reconnects: Int = 0) = writeArray(
        "sessions.json",
        sessions().reversed().map {
            if (it.sid == sid && it.endedAt == null) it.copy(endedAt = System.currentTimeMillis(), endReason = reason, reconnects = reconnects) else it
        }.map { it.toJson() },
    )

    // ---------------- Chat timeline (per desktop) ----------------
    // Entries are JSON objects with the same shape as the desktop's ChatEntry:
    // {kind:"msg", id, from:"me"|"peer", text, ts, delivered?} | {kind:"file", id, from, name, size, ts, ok, uri?}

    @Synchronized
    fun chat(fingerprint: String): List<JSONObject> = readObject("chats.json").optJSONArray(fingerprint)?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }
    } ?: emptyList()

    @Synchronized
    fun putChat(fingerprint: String, entry: JSONObject) {
        val all = readObject("chats.json")
        val list = chat(fingerprint).filter { it.optString("id") != entry.optString("id") } + entry
        all.put(fingerprint, JSONArray(list.takeLast(500)))
        writeObject("chats.json", all)
    }

    @Synchronized
    fun markDelivered(fingerprint: String, id: String) {
        val e = chat(fingerprint).firstOrNull { it.optString("id") == id && it.optString("kind") == "msg" } ?: return
        putChat(fingerprint, e.put("delivered", true))
    }

    @Synchronized
    fun clearChat(fingerprint: String) {
        val all = readObject("chats.json")
        all.remove(fingerprint)
        writeObject("chats.json", all)
    }

    private fun readObject(name: String): JSONObject {
        val f = File(dir, name)
        return if (f.exists()) JSONObject(f.readText()) else JSONObject()
    }

    private fun writeObject(name: String, o: JSONObject) {
        val tmp = File(dir, "$name.tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(File(dir, name))
    }

    var settings: Settings
        get() = Settings(
            prefs.getString("signalingUrl", null) ?: "",
            prefs.getString("deviceName", null) ?: (android.os.Build.MODEL ?: "Android"),
        )
        set(v) {
            prefs.edit().putString("signalingUrl", v.signalingUrl).putString("deviceName", v.deviceName.take(64)).apply()
        }

    private fun readArray(name: String): List<JSONObject> {
        val f = File(dir, name)
        if (!f.exists()) return emptyList()
        val arr = JSONArray(f.readText())
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun writeArray(name: String, items: List<JSONObject>) {
        val tmp = File(dir, "$name.tmp")
        tmp.writeText(JSONArray(items).toString())
        tmp.renameTo(File(dir, name))
    }
}
