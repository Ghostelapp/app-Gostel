package app.ghostel

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class GhostelCallNotificationModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "GhostelCallNotification"

  @ReactMethod
  fun showIncomingCall(data: ReadableMap, promise: Promise) {
    try {
      val callId = data.getStringOrEmpty("call_id")
      val callerName = data.getStringOrEmpty("caller_name")
        .ifBlank { data.getStringOrEmpty("sender_name").ifBlank { "Ghostel" } }
      if (callId.isBlank()) {
        promise.resolve(false)
        return
      }

      val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      ensureChannel(nm)

      val intent = Intent(reactContext, MainActivity::class.java).apply {
        action = ACTION_INCOMING_CALL
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra("ghostel_incoming_call", true)
        putExtra("call_id", callId)
        putExtra("caller_id", data.getStringOrEmpty("caller_id"))
        putExtra("caller_name", callerName)
        putExtra("conversation_id", data.getStringOrEmpty("conversation_id"))
        putExtra("mode", data.getStringOrEmpty("mode").ifBlank { "audio" })
      }
      val pendingIntent = PendingIntent.getActivity(
        reactContext,
        notificationId(callId),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )

      val requestCode = notificationId(callId)
      val answerIntent = PendingIntent.getActivity(
        reactContext,
        requestCode + 1,
        Intent(intent).putExtra("ghostel_call_action", "answer"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val declineIntent = PendingIntent.getActivity(
        reactContext,
        requestCode + 2,
        Intent(intent).putExtra("ghostel_call_action", "decline"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )

      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(reactContext, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(reactContext)
      }

      builder
        .setSmallIcon(android.R.drawable.sym_call_incoming)
        .setContentTitle("Ghostel: $callerName")
        .setContentText("Połączenie przychodzące w aplikacji")
        .setCategory(Notification.CATEGORY_CALL)
        .setPriority(Notification.PRIORITY_MAX)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(pendingIntent)
        .setFullScreenIntent(pendingIntent, true)
        .setSound(ringtoneUri(), audioAttrs())
        .setVibrate(longArrayOf(0, 1000, 500, 1000, 500, 1000))

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val caller = Person.Builder()
          .setName(callerName)
          .setImportant(true)
          .build()
        builder.setStyle(
          Notification.CallStyle
            .forIncomingCall(caller, declineIntent, answerIntent)
            .setIsVideo(false)
        )
      } else {
        builder
          .addAction(android.R.drawable.sym_call_missed, "Odrzuć", declineIntent)
          .addAction(android.R.drawable.sym_call_outgoing, "Odbierz", answerIntent)
      }

      val notification = builder.build()

      nm.notify(notificationId(callId), notification)
      Log.i(TAG, "Posted full-screen call notification channel=$CHANNEL_ID callId=$callId")
      openActivityIfLockedOrScreenOff(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ghostel_call_notification_failed", e)
    }
  }

  @ReactMethod
  fun cancelIncomingCall(callId: String, promise: Promise) {
    try {
      val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.cancel(notificationId(callId))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ghostel_call_notification_cancel_failed", e)
    }
  }

  @ReactMethod
  fun consumeInitialIncomingCall(promise: Promise) {
    try {
      val intent = MainActivity.consumePendingIncomingCallIntent()
      val callId = intent?.getStringExtra("call_id").orEmpty()
      val callerId = intent?.getStringExtra("caller_id").orEmpty()
      if (callId.isBlank() || callerId.isBlank()) {
        promise.resolve(null)
        return
      }

      val map = Arguments.createMap().apply {
        putString("id", callId)
        putString("call_id", callId)
        putString("caller_id", callerId)
        putString("caller_name", intent?.getStringExtra("caller_name").orEmpty())
        putString("conversation_id", intent?.getStringExtra("conversation_id").orEmpty())
        putString("mode", intent?.getStringExtra("mode").orEmpty().ifBlank { "audio" })
        putString("type", "incoming_call")
        putString("kind", "call")
        putString("push_kind", "call")
      }
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("ghostel_call_notification_initial_failed", e)
    }
  }

  private fun ensureChannel(nm: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Incoming Ghostel calls",
      NotificationManager.IMPORTANCE_MAX
    ).apply {
      description = "Full-screen Ghostel incoming call alerts"
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setBypassDnd(true)
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 1000, 500, 1000, 500, 1000)
      setSound(ringtoneUri(), audioAttrs())
    }
    nm.createNotificationChannel(channel)
  }

  private fun ringtoneUri(): Uri =
    Uri.parse("android.resource://${reactContext.packageName}/raw/ringtone")

  private fun audioAttrs(): AudioAttributes =
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

  private fun openActivityIfLockedOrScreenOff(intent: Intent) {
    try {
      val keyguard = reactContext.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      val power = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
      val locked = keyguard.isKeyguardLocked
      val screenOff = !power.isInteractive
      if (locked || screenOff) {
        reactContext.startActivity(intent)
      }
    } catch (_: Exception) {
      /* keep the notification fallback */
    }
  }

  private fun notificationId(callId: String): Int =
    callId.hashCode().let { if (it == Int.MIN_VALUE) 1 else kotlin.math.abs(it) }

  companion object {
    const val CHANNEL_ID = "ghostel_calls_fullscreen_v4"
    const val ACTION_INCOMING_CALL = "app.ghostel.INCOMING_CALL"
    private const val TAG = "GhostelCallNotification"
  }
}

private fun ReadableMap.getStringOrEmpty(key: String): String =
  if (hasKey(key) && !isNull(key)) getString(key) ?: "" else ""
