package com.remotecontroller.android.core.session

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

/**
 * Screen capturer built on one MediaProjection and one VirtualDisplay for the whole session.
 *
 * Android 14+ allows a projection token to create a virtual display only once; libwebrtc's
 * ScreenCapturerAndroid recreates its display in changeCaptureFormat(), which throws a
 * SecurityException on quality changes or rotation. Here size changes use VirtualDisplay.resize().
 */
class ProjectionCapturer(
    private val resultData: Intent,
    private val onStopped: () -> Unit,
) : VideoCapturer, VideoSink {
    private lateinit var context: Context
    private lateinit var helper: SurfaceTextureHelper
    private lateinit var observer: CapturerObserver
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var width = 0
    private var height = 0

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() = onStopped()
    }

    override fun initialize(helper: SurfaceTextureHelper, context: Context, observer: CapturerObserver) {
        this.helper = helper
        this.context = context
        this.observer = observer
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        this.width = width
        this.height = height
        val mpm = context.getSystemService(MediaProjectionManager::class.java)
        val p = mpm.getMediaProjection(Activity.RESULT_OK, resultData) ?: error("media projection unavailable")
        projection = p
        // The callback must be registered before creating the display (required on Android 14+).
        p.registerCallback(projectionCallback, helper.handler)
        helper.handler.post {
            helper.setTextureSize(width, height)
            display = createDisplay(p, width, height)
            observer.onCapturerStarted(true)
            helper.startListening(this)
        }
    }

    /**
     * Android 14+: resizes the existing virtual display (a second one is not allowed). Older
     * versions recreate it instead: on some of them (seen on MIUI / Android 11) resize() grows the
     * buffer but the mirrored screen keeps its old size, drawn in a corner of the frame.
     */
    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        if (width == this.width && height == this.height) return
        this.width = width
        this.height = height
        helper.handler.post {
            helper.setTextureSize(width, height)
            val p = projection
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE || p == null) {
                display?.resize(width, height, DENSITY_DPI)
            } else {
                display?.release()
                display = createDisplay(p, width, height)
            }
        }
    }

    private fun createDisplay(p: MediaProjection, width: Int, height: Int) = p.createVirtualDisplay(
        "rc-screen", width, height, DENSITY_DPI, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        Surface(helper.surfaceTexture), null, null,
    )

    override fun onFrame(frame: VideoFrame) = observer.onFrameCaptured(frame)

    override fun stopCapture() {
        helper.handler.post {
            helper.stopListening()
            observer.onCapturerStopped()
            display?.release()
            display = null
            projection?.unregisterCallback(projectionCallback)
            projection?.stop()
            projection = null
        }
    }

    override fun dispose() {}

    override fun isScreencast() = true

    companion object {
        private const val DENSITY_DPI = 400
    }
}
