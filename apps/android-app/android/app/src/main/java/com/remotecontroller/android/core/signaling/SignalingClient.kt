package com.remotecontroller.android.core.signaling

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Reconnecting signaling client (OkHttp WebSocket). Joined rooms are re-joined after every
 * reconnect so a Wi-Fi/mobile switch does not drop the pairing channel. Callbacks run on the main thread.
 */
class SignalingClient {
    enum class Status { OFFLINE, CONNECTING, ONLINE }

    interface Listener {
        fun onStatus(status: Status) {}
        fun onMessage(msg: JSONObject) {}
    }

    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<Listener>()
    private val rooms = LinkedHashMap<String, String>() // room -> role
    private var ws: WebSocket? = null
    private var url: String? = null
    private var backoffMs = 500L
    private var stopped = true

    var status = Status.OFFLINE
        private set

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)

    fun start(url: String) {
        main.post {
            if (!stopped && this.url == url) return@post
            this.url = url
            stopped = false
            ws?.cancel()
            connect()
        }
    }

    fun stop() = main.post {
        stopped = true
        main.removeCallbacksAndMessages(RECONNECT)
        ws?.close(1000, null)
        ws = null
        setStatus(Status.OFFLINE)
    }

    fun join(room: String) = main.post {
        rooms[room] = ROLE
        // When not yet open, onOpen joins every room; sending now too would join twice.
        if (status == Status.ONLINE) send(JSONObject().put("t", "join").put("room", room).put("role", ROLE))
    }

    fun leave(room: String) = main.post {
        if (rooms.remove(room) != null) send(JSONObject().put("t", "leave").put("room", room))
    }

    fun relay(room: String, data: JSONObject) = main.post {
        send(JSONObject().put("t", "relay").put("room", room).put("data", data))
    }

    fun requestTurn() = main.post { send(JSONObject().put("t", "turn")) }

    private fun send(o: JSONObject) {
        ws?.send(o.toString())
    }

    private fun setStatus(s: Status) {
        status = s
        listeners.forEach { it.onStatus(s) }
    }

    private fun connect() {
        val u = url ?: return
        setStatus(Status.CONNECTING)
        val req = try {
            Request.Builder().url(u).build()
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "invalid signaling url $u")
            setStatus(Status.OFFLINE)
            return
        }
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = main.post {
                if (ws !== webSocket) return@post
                backoffMs = 500
                setStatus(Status.ONLINE)
                rooms.forEach { (room, role) -> send(JSONObject().put("t", "join").put("room", room).put("role", role)) }
            }.let {}

            override fun onMessage(webSocket: WebSocket, text: String) = main.post {
                if (ws !== webSocket) return@post
                val msg = try { JSONObject(text) } catch (e: Exception) { return@post }
                listeners.forEach { it.onMessage(msg) }
            }.let {}

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
        })
    }

    private fun dropped(socket: WebSocket) = main.post {
        if (ws !== socket) return@post
        ws = null
        setStatus(Status.OFFLINE)
        if (!stopped) {
            main.postAtTime({ connect() }, RECONNECT, android.os.SystemClock.uptimeMillis() + backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(10_000)
        }
    }.let {}

    companion object {
        private const val TAG = "RcSignaling"
        private const val ROLE = "android"
        private val RECONNECT = Any()

        /** Parses `turn-credentials.iceServers` into (urls, username, credential) triples. */
        fun parseIceServers(arr: JSONArray): List<Triple<List<String>, String?, String?>> = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            val urls = o.get("urls").let { u -> if (u is JSONArray) (0 until u.length()).map { u.getString(it) } else listOf(u.toString()) }
            Triple(urls, o.optString("username").ifEmpty { null }, o.optString("credential").ifEmpty { null })
        }
    }
}
