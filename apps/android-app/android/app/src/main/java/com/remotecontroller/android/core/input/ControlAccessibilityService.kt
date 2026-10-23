package com.remotecontroller.android.core.input

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import com.remotecontroller.android.core.RcCore
import org.json.JSONObject

/**
 * Executes remote input with the accessibility gesture API and shows the "being controlled"
 * overlay. It does nothing on its own: commands only arrive from an active, user-accepted session.
 */
class ControlAccessibilityService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private var overlay: View? = null

    // Continued-stroke state for a single pointer (API 26+).
    private var stroke: GestureDescription.StrokeDescription? = null
    private var lastX = 0f
    private var lastY = 0f
    private var lastTs = 0L
    private var inFlight = false
    private var pendingMove: Pair<Float, Float>? = null
    private var pendingUp: Pair<Float, Float>? = null
    private var downPoint: Pair<Float, Float>? = null
    private var downTs = 0L
    private var streaming = false
    private val touchSlop by lazy { 8 * resources.displayMetrics.density }

    override fun onServiceConnected() {
        instance = this
        RcCore.get(this).onAccessibilityChanged()
        if (RcCore.get(this).sessionActive) showIndicator(true)
    }

    override fun onDestroy() {
        showIndicator(false)
        instance = null
        RcCore.peek()?.onAccessibilityChanged()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    // ---------------- Indicator overlay ----------------

    /** Red border + label across the top of the screen for the whole session. Not dismissible. */
    fun showIndicator(show: Boolean) = main.post {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (!show) {
            overlay?.let { runCatching { wm.removeView(it) } }
            overlay = null
            return@post
        }
        if (overlay != null) return@post
        val density = resources.displayMetrics.density
        val label = TextView(this).apply {
            text = "● Controle remoto ativo"
            setTextColor(Color.WHITE)
            textSize = 11f
            setPadding((10 * density).toInt(), (3 * density).toInt(), (10 * density).toInt(), (3 * density).toInt())
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#E5DC2626"))
                cornerRadius = 12 * density
            }
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = (28 * density).toInt()
        }
        runCatching { wm.addView(label, params) }.onSuccess { overlay = label }
    }.let {}

    // ---------------- Input ----------------

    private fun screenSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.currentWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val m = DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(m)
            m.widthPixels to m.heightPixels
        }
    }

    private fun toPx(x: Double, y: Double): Pair<Float, Float> {
        val (w, h) = screenSize()
        return (x * (w - 1)).toFloat() to (y * (h - 1)).toFloat()
    }

    fun handle(msg: JSONObject) = main.post {
        when (msg.optString("t")) {
            "pd" -> pointerDown(toPx(msg.getDouble("x"), msg.getDouble("y")))
            "pm" -> pointerMove(toPx(msg.getDouble("x"), msg.getDouble("y")))
            "pu" -> pointerUp(toPx(msg.getDouble("x"), msg.getDouble("y")))
            "scroll" -> scroll(msg)
            "global" -> global(msg.getString("action"))
            "text" -> insertText(msg.getString("text"))
            "edit" -> edit(msg.getString("key"))
        }
    }.let {}

    private fun segment(fromX: Float, fromY: Float, toX: Float, toY: Float) = Path().apply {
        moveTo(fromX, fromY)
        lineTo(toX, toY)
    }

    private fun dispatch(s: GestureDescription.StrokeDescription) {
        inFlight = true
        val ok = dispatchGesture(GestureDescription.Builder().addStroke(s).build(), object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                inFlight = false
                flush()
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                Log.w(TAG, "gesture cancelled")
                inFlight = false
                stroke = null
                pendingMove = null
                pendingUp = null
            }
        }, main)
        if (!ok) {
            Log.w(TAG, "gesture rejected")
            inFlight = false
            stroke = null
        }
    }

    /**
     * Taps are sent as one complete gesture on release (most reliable for apps). Only when the
     * pointer moves past the touch slop or is held (long press) do we switch to streaming the
     * stroke live as continued segments, so drags follow the mouse.
     */
    private fun pointerDown(p: Pair<Float, Float>) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        main.removeCallbacks(startStreaming)
        pendingMove = null
        pendingUp = null
        stroke = null
        streaming = false
        downPoint = p
        downTs = SystemClock.uptimeMillis()
        main.postDelayed(startStreaming, LONG_PRESS_STREAM_MS)
    }

    private val startStreaming = Runnable {
        val d = downPoint ?: return@Runnable
        if (streaming) return@Runnable
        streaming = true
        lastX = d.first
        lastY = d.second
        lastTs = SystemClock.uptimeMillis()
        stroke = GestureDescription.StrokeDescription(segment(lastX, lastY, lastX, lastY), 0, 1, true).also { dispatch(it) }
    }

    private fun pointerMove(p: Pair<Float, Float>) {
        val d = downPoint ?: return
        if (!streaming) {
            if (Math.hypot((p.first - d.first).toDouble(), (p.second - d.second).toDouble()) < touchSlop) return
            main.removeCallbacks(startStreaming)
            startStreaming.run()
        }
        pendingMove = p
        if (!inFlight) flush()
    }

    private fun pointerUp(p: Pair<Float, Float>) {
        val d = downPoint ?: return
        downPoint = null
        main.removeCallbacks(startStreaming)
        if (!streaming) {
            val duration = (SystemClock.uptimeMillis() - downTs).coerceIn(30, 200)
            dispatch(GestureDescription.StrokeDescription(segment(d.first, d.second, p.first, p.second), 0, duration, false))
            return
        }
        if (stroke == null) return
        pendingUp = p
        if (!inFlight) flush()
    }

    /** Sends the newest pending segment as a continuation of the current stroke. */
    private fun flush() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val prev = stroke ?: return
        val up = pendingUp
        val target = up ?: pendingMove ?: return
        pendingMove = null
        val now = SystemClock.uptimeMillis()
        val duration = (now - lastTs).coerceIn(8, 120)
        val next = prev.continueStroke(segment(lastX, lastY, target.first, target.second), 0, duration, up == null)
        lastX = target.first
        lastY = target.second
        lastTs = now
        if (up != null) {
            pendingUp = null
            stroke = null
        } else {
            stroke = next
        }
        dispatch(next)
    }

    private fun scroll(msg: JSONObject) {
        if (downPoint != null || stroke != null) return
        val (w, h) = screenSize()
        val (x, y) = toPx(msg.getDouble("x"), msg.getDouble("y"))
        // Wheel down (dy > 0) means content moves up: the finger swipes upward.
        val toX = (x - msg.getDouble("dx") * w).toFloat().coerceIn(0f, w - 1f)
        val toY = (y - msg.getDouble("dy") * h).toFloat().coerceIn(0f, h - 1f)
        dispatchGesture(
            GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(segment(x, y, toX, toY), 0, 150)).build(),
            null,
            null,
        )
    }

    private fun global(action: String) {
        val a = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quickSettings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "lockScreen" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN else return
            else -> return
        }
        performGlobalAction(a)
    }

    private fun focusedInput(): AccessibilityNodeInfo? =
        rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }

    private fun currentText(node: AccessibilityNodeInfo): String {
        val showingHint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText
        return if (showingHint) "" else node.text?.toString() ?: ""
    }

    private fun setText(node: AccessibilityNodeInfo, text: String, cursor: Int) {
        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        })
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
    }

    private fun selection(node: AccessibilityNodeInfo, len: Int): Pair<Int, Int> {
        var s = node.textSelectionStart
        var e = node.textSelectionEnd
        if (s < 0 || e < 0 || s > len || e > len) {
            s = len
            e = len
        }
        return minOf(s, e) to maxOf(s, e)
    }

    private fun insertText(text: String) {
        val node = focusedInput() ?: return
        val cur = currentText(node)
        val (s, e) = selection(node, cur.length)
        setText(node, cur.substring(0, s) + text + cur.substring(e), s + text.length)
    }

    private fun edit(key: String) {
        val node = focusedInput()
        when (key) {
            "Backspace", "Delete" -> {
                node ?: return
                val cur = currentText(node)
                val (s, e) = selection(node, cur.length)
                when {
                    s != e -> setText(node, cur.removeRange(s, e), s)
                    key == "Backspace" && s > 0 -> setText(node, cur.removeRange(s - 1, s), s - 1)
                    key == "Delete" && s < cur.length -> setText(node, cur.removeRange(s, s + 1), s)
                }
            }
            "Enter" -> {
                node ?: return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                } else if (node.isMultiLine) {
                    insertText("\n")
                }
            }
            "SelectAll" -> node?.let {
                it.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, currentText(it).length)
                })
            }
            "Copy" -> node?.performAction(AccessibilityNodeInfo.ACTION_COPY)
            "Paste" -> node?.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            "Cut" -> node?.performAction(AccessibilityNodeInfo.ACTION_CUT)
        }
    }

    companion object {
        private const val TAG = "RcInput"
        private const val LONG_PRESS_STREAM_MS = 250L

        @Volatile
        var instance: ControlAccessibilityService? = null
            private set

        fun isEnabled(context: Context): Boolean {
            val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = "${context.packageName}/${ControlAccessibilityService::class.java.name}"
            return enabled.split(':').any { it.equals(me, ignoreCase = true) }
        }
    }
}
