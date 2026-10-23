package com.remotecontroller.android.core.session

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RTCStatsReport
import android.os.Handler
import android.os.HandlerThread
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.nio.ByteBuffer

/**
 * WebRTC side of a session: screen capture (MediaProjection) -> hardware encoder (MediaCodec via
 * DefaultVideoEncoderFactory, software only as fallback) -> SRTP, plus the data channels.
 * The phone is the offerer.
 */
class WebRtcSession(
    private val context: Context,
    projectionData: Intent,
    iceServers: List<PeerConnection.IceServer>,
    private val listener: Listener,
    /** USB sessions: the only path is the desktop's TURN relay, reached through adb reverse. */
    private val relayOnly: Boolean = false,
) {
    interface Listener {
        fun onLocalSdp(type: String, sdp: String)
        fun onLocalIce(candidate: IceCandidate)
        fun onControl(msg: JSONObject)
        fun onConnectionState(state: PeerConnection.PeerConnectionState)
        fun onProjectionStopped()
        /** JSON frame on the "chat" or "file" channel (data-channel thread). */
        fun onData(label: String, msg: JSONObject) {}
        /** Binary frame on the "file" channel (data-channel thread). */
        fun onFileChunk(frame: ByteArray) {}
    }

    data class Quality(val maxLongSide: Int, val fps: Int, val maxBitrate: Int)

    private val egl = EglBase.create()
    private val factory: PeerConnectionFactory
    private val capturer: ProjectionCapturer
    private val textureHelper: SurfaceTextureHelper
    private val videoSource: VideoSource
    private val track: VideoTrack
    private val pc: PeerConnection
    private val sender: RtpSender
    private val channels = HashMap<String, DataChannel>()
    private var quality = PRESETS.getValue("medium")
    private var presetName = "medium"
    private var captureSize = 0 to 0
    @Volatile private var closed = false
    private val drain = Object()
    private val statsThread = HandlerThread("rc-stats").apply { start() }
    private val statsHandler = Handler(statsThread.looper)
    private val statsTick = object : Runnable {
        override fun run() {
            if (closed) return
            pc.getStats { report -> guarded("stats") { sendSenderStats(report) } }
            statsHandler.postDelayed(this, 1000)
        }
    }

    private val observer = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) = listener.onLocalIce(candidate)
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = listener.onConnectionState(newState)
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
    }

    init {
        ensureInitialized(context)
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()

        capturer = ProjectionCapturer(projectionData) { if (!closed) listener.onProjectionStopped() }
        textureHelper = SurfaceTextureHelper.create("rc-capture", egl.eglBaseContext)
        videoSource = factory.createVideoSource(true)
        capturer.initialize(textureHelper, context, videoSource.capturerObserver)
        captureSize = captureDimensions()
        capturer.startCapture(captureSize.first, captureSize.second, quality.fps)
        track = factory.createVideoTrack("screen", videoSource)

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            if (relayOnly) iceTransportsType = PeerConnection.IceTransportsType.RELAY
        }
        pc = factory.createPeerConnection(config, observer) ?: error("PeerConnection creation failed")
        sender = pc.addTrack(track, listOf("screen"))
        startBitrate()
        applyEncoding()

        openChannel("control", ordered = false, maxRetransmits = 0)
        openChannel("control-r")
        openChannel("session")
        openChannel("chat")
        openChannel("file")

        createOffer(iceRestart = false)
    }

    // ---------------- Signaling ----------------

    fun setRemoteAnswer(sdp: String) {
        pc.setRemoteDescription(object : SimpleSdp("setRemote") {
            // The transport exists only now: apply the USB start rate again so it takes effect.
            override fun onSetSuccess() = startBitrate()
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    /**
     * WebRTC's bandwidth estimate starts around 300 kbit/s, sized for an unknown internet path, and
     * climbs from there: on a 1920-pixel screen that is seconds of smeared, stuttering video and
     * a relapse every time the estimate dips. Over the USB cable bandwidth is plentiful, so start
     * high and never fall below a floor.
     */
    private fun startBitrate() {
        if (relayOnly) pc.setBitrate(USB_MIN_BPS, USB_START_BPS, null)
    }

    fun addRemoteIce(candidate: String, sdpMid: String?, sdpMLineIndex: Int) {
        pc.addIceCandidate(IceCandidate(sdpMid ?: "0", sdpMLineIndex, candidate))
    }

    fun isConnected() = !closed && pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED

    /** New offer with fresh ICE credentials, e.g. after the network changed. */
    fun restartIce() = createOffer(iceRestart = true)

    private fun createOffer(iceRestart: Boolean) {
        val constraints = MediaConstraints().apply {
            if (iceRestart) mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
        }
        pc.createOffer(object : SimpleSdp("createOffer") {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(object : SimpleSdp("setLocal") {
                    override fun onSetSuccess() = listener.onLocalSdp("offer", desc.description)
                }, desc)
            }
        }, constraints)
    }

    // ---------------- Data channels ----------------

    private fun openChannel(label: String, ordered: Boolean = true, maxRetransmits: Int = -1) {
        val init = DataChannel.Init().apply {
            this.ordered = ordered
            if (maxRetransmits >= 0) this.maxRetransmits = maxRetransmits
        }
        val ch = pc.createDataChannel(label, init) ?: return
        channels[label] = ch
        ch.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {
                if (label == "file") synchronized(drain) { drain.notifyAll() }
            }
            override fun onStateChange() {
                if (label == "session" && ch.state() == DataChannel.State.OPEN) {
                    sendScreen()
                    sendQualityApplied()
                    statsHandler.removeCallbacks(statsTick)
                    statsHandler.post(statsTick)
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) = guarded("message on $label") { handleMessage(buffer) }

            private fun handleMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                if (buffer.binary) {
                    if (label == "file") listener.onFileChunk(bytes)
                    return
                }
                val msg = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (e: Exception) { return }
                when (label) {
                    "control", "control-r" -> listener.onControl(msg)
                    "session" -> onSessionMessage(msg)
                    "chat", "file" -> listener.onData(label, msg)
                }
            }
        })
    }

    fun sendJson(label: String, o: JSONObject): Boolean {
        val ch = channels[label] ?: return false
        if (ch.state() != DataChannel.State.OPEN) return false
        return ch.send(DataChannel.Buffer(ByteBuffer.wrap(o.toString().toByteArray(Charsets.UTF_8)), false))
    }

    /**
     * Sends one binary frame on the file channel, blocking the calling (worker) thread while more
     * than [MAX_BUFFERED] bytes are queued so a large file cannot exhaust memory.
     */
    fun sendFileFrame(frame: ByteArray) {
        val ch = channels["file"] ?: throw IllegalStateException("no file channel")
        synchronized(drain) {
            while (!closed && ch.state() == DataChannel.State.OPEN && ch.bufferedAmount() > MAX_BUFFERED) drain.wait(200)
        }
        if (closed || ch.state() != DataChannel.State.OPEN) throw IllegalStateException("file channel closed")
        ch.send(DataChannel.Buffer(ByteBuffer.wrap(frame), true))
    }

    private fun onSessionMessage(msg: JSONObject) {
        when (msg.optString("t")) {
            "quality" -> setQuality(msg.optString("preset"))
            "hb" -> sendJson("session", JSONObject().put("t", "hb").put("ts", msg.optLong("ts")))
        }
    }

    fun sendSessionEnd(reason: String) = sendJson("session", JSONObject().put("t", "end").put("reason", reason))

    private fun sendScreen() {
        val (w, h) = realScreen()
        sendJson("session", JSONObject().put("t", "screen").put("w", w).put("h", h).put("rotation", rotation()))
    }

    private fun sendQualityApplied() = sendJson(
        "session",
        JSONObject().put("t", "quality-applied").put("preset", presetName)
            .put("w", captureSize.first).put("h", captureSize.second).put("fps", quality.fps).put("maxBitrate", quality.maxBitrate),
    )

    // ---------------- Quality / geometry ----------------

    fun setQuality(preset: String) {
        val q = PRESETS[preset] ?: return
        presetName = preset
        quality = q
        captureSize = captureDimensions()
        capturer.changeCaptureFormat(captureSize.first, captureSize.second, q.fps)
        applyEncoding()
        sendQualityApplied()
    }

    /** Called on rotation/resolution change: the virtual display must follow the real screen. */
    fun onDisplayChanged() {
        val size = captureDimensions()
        if (size == captureSize) return
        captureSize = size
        capturer.changeCaptureFormat(size.first, size.second, quality.fps)
        sendScreen()
        sendQualityApplied()
    }

    private fun applyEncoding() {
        val params = sender.parameters
        // Low favours smooth motion over sharpness; the others let WebRTC balance both.
        params.degradationPreference = if (presetName == "low") RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
        else RtpParameters.DegradationPreference.BALANCED
        params.encodings.forEach {
            it.maxBitrateBps = quality.maxBitrate
            it.maxFramerate = quality.fps
            it.minBitrateBps = if (relayOnly) quality.maxBitrate / 2 else null
        }
        sender.parameters = params
    }

    private fun realScreen(): Pair<Int, Int> {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.maximumWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val m = DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(m)
            m.widthPixels to m.heightPixels
        }
    }

    @Suppress("DEPRECATION")
    private fun rotation(): Int = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation

    /** Real screen scaled so the long side fits the preset, aligned to 16 px for hardware encoders. */
    private fun captureDimensions(): Pair<Int, Int> {
        val (w, h) = realScreen()
        val scale = minOf(1.0, quality.maxLongSide.toDouble() / maxOf(w, h))
        fun align(v: Double) = maxOf(16, (v / 16).toInt() * 16)
        return align(w * scale) to align(h * scale)
    }

    // ---------------- Lifecycle ----------------

    /**
     * Sender-side link view for the desktop's adaptive controller: the bandwidth estimate
     * (availableOutgoingBitrate) only exists on the sending side.
     */
    private fun sendSenderStats(report: RTCStatsReport) {
        var bitrate: Double? = null
        var rtt: Double? = null
        var fps: Double? = null
        var limitation: String? = null
        val stats = report.statsMap.values
        val transport = stats.firstOrNull { it.type == "transport" }
        val pairId = transport?.members?.get("selectedCandidatePairId") as? String
        val pair = stats.firstOrNull { it.type == "candidate-pair" && (it.id == pairId || (pairId == null && it.members["nominated"] == true)) }
        fun num(v: Any?) = (v as? Number)?.toDouble()?.takeIf { it.isFinite() }
        pair?.members?.let { m ->
            bitrate = num(m["availableOutgoingBitrate"])
            rtt = num(m["currentRoundTripTime"])?.times(1000)
        }
        stats.firstOrNull { it.type == "outbound-rtp" && it.members["kind"] == "video" }?.members?.let { m ->
            fps = num(m["framesPerSecond"])
            limitation = m["qualityLimitationReason"] as? String
        }
        sendJson(
            "session",
            JSONObject().put("t", "sender-stats")
                .put("availableBitrate", bitrate ?: JSONObject.NULL)
                .put("rttMs", rtt ?: JSONObject.NULL)
                .put("encodeFps", fps ?: JSONObject.NULL)
                .put("qualityLimitation", limitation ?: JSONObject.NULL),
        )
    }

    /**
     * Runs code invoked from a native WebRTC thread. A Java exception escaping a JNI callback makes
     * libwebrtc abort the whole process (RTC_CHECK(!env->ExceptionCheck())), so none may escape.
     */
    private inline fun guarded(what: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            Log.e(TAG, "error in WebRTC callback ($what)", e)
        }
    }

    fun close() {
        if (closed) return
        closed = true
        statsHandler.removeCallbacks(statsTick)
        statsThread.quitSafely()
        synchronized(drain) { drain.notifyAll() }
        runCatching { capturer.stopCapture() }
        channels.values.forEach { runCatching { it.close(); it.dispose() } }
        runCatching { pc.dispose() }
        runCatching { capturer.dispose() }
        runCatching { videoSource.dispose() }
        runCatching { textureHelper.dispose() }
        runCatching { factory.dispose() }
        runCatching { egl.release() }
    }

    private open class SimpleSdp(val op: String) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) = Log.w(TAG, "$op failed: $error").let {}
        override fun onSetFailure(error: String?) = Log.w(TAG, "$op failed: $error").let {}
    }

    companion object {
        private const val TAG = "RcWebRtc"
        private const val MAX_BUFFERED = 4L * 1024 * 1024
        private const val USB_MIN_BPS = 1_500_000
        private const val USB_START_BPS = 6_000_000

        val PRESETS = mapOf(
            "high" to Quality(1920, 60, 8_000_000),
            "medium" to Quality(1280, 30, 2_500_000),
            "low" to Quality(960, 24, 800_000),
        )

        @Volatile private var initialized = false

        private fun ensureInitialized(context: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
            )
            initialized = true
        }
    }
}
