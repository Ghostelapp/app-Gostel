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
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class GhostelFirebaseMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data ?: return
    if (isCallControl(data)) {
      handleCallControl(data)
      return
    }

    val isCall =
      data["type"] == "incoming_call" ||
        data["type"] == "call" ||
        data["kind"] == "call" ||
        data["push_kind"] == "call"
    if (!isCall) return

    val callId = data["call_id"].orEmpty()
    val callerId = data["caller_id"].orEmpty()
    val callerName = data["caller_name"].orEmpty()
      .ifBlank { data["sender_name"].orEmpty().ifBlank { "ghostel.app" } }
    if (callId.isBlank() || callerId.isBlank()) return

    try {
      val intent = IncomingCallIntentSecurity.protect(this, Intent(this, MainActivity::class.java).apply {
        action = GhostelCallNotificationModule.ACTION_INCOMING_CALL
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra("ghostel_incoming_call", true)
        putExtra("call_id", callId)
        putExtra("caller_id", callerId)
        putExtra("caller_name", callerName)
        putExtra("conversation_id", data["conversation_id"].orEmpty())
        putExtra("mode", data["mode"].orEmpty().ifBlank { "audio" })
      })

      wakeScreenBriefly()
      showFullScreenCallNotification(callId, callerName, intent)
      startRingingCallService(callId, callerName)
      openActivityIfLockedOrScreenOff(intent)
      Log.i(TAG, "Incoming call handled natively callId=$callId caller=$callerName")
    } catch (e: Exception) {
      Log.w(TAG, "Incoming call native handling failed", e)
    }
  }

  private fun isCallControl(data: Map<String, String>): Boolean =
    data["type"] == "call_control" ||
      data["type"] == "call:accepted" ||
      data["type"] == "call:ended" ||
      data["call_control_action"].orEmpty().isNotBlank()

  private fun handleCallControl(data: Map<String, String>) {
    val callId = data["call_id"].orEmpty()
    if (callId.isBlank()) return
    val action = data["call_control_action"].orEmpty()
      .ifBlank { data["status"].orEmpty() }
      .ifBlank { data["type"].orEmpty() }
    try {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.cancel(notificationId(callId))
      if (action != "accepted") {
        stopService(Intent(this, GhostelActiveCallService::class.java))
      }
      Log.i(TAG, "Call control handled action=$action callId=$callId")
    } catch (e: Exception) {
      Log.w(TAG, "Call control handling failed callId=$callId", e)
    }
  }

  private fun showFullScreenCallNotification(
    callId: String,
    callerName: String,
    intent: Intent,
  ) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureChannel(nm)

    val pendingIntent = PendingIntent.getActivity(
      this,
      notificationId(callId),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val requestCode = notificationId(callId)
    val answerIntent = PendingIntent.getActivity(
      this,
      requestCode + 1,
      Intent(intent).putExtra("ghostel_call_action", "answer"),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val declineIntent = PendingIntent.getActivity(
      this,
      requestCode + 2,
      Intent(intent).putExtra("ghostel_call_action", "decline"),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, GhostelCallNotificationModule.CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    builder
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle("ghostel.app: $callerName")
      .setContentText("Połączenie przychodzące w aplikacji")
      .setCategory(Notification.CATEGORY_CALL)
      .setPriority(Notification.PRIORITY_MAX)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOngoing(true)
      .setAutoCancel(false)
      .setContentIntent(pendingIntent)
      .setFullScreenIntent(pendingIntent, canUseFullScreenIntent(nm))
      .setSound(ringtoneUri(), audioAttrs())
      .setVibrate(longArrayOf(0, 1000, 500, 1000, 500, 1000))
      .setTimeoutAfter(45_000)

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

    val notification = builder.build().apply {
      flags = flags or Notification.FLAG_INSISTENT or Notification.FLAG_ONGOING_EVENT
    }

    nm.notify(notificationId(callId), notification)
    Log.i(
      TAG,
      "Posted full-screen call notification channel=${GhostelCallNotificationModule.CHANNEL_ID} callId=$callId"
    )
  }

  private fun ensureChannel(nm: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      GhostelCallNotificationModule.CHANNEL_ID,
      "ghostel.app full-screen calls",
      NotificationManager.IMPORTANCE_MAX
    ).apply {
      description = "Full-screen ghostel.app incoming call alerts"
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      setBypassDnd(true)
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 1000, 500, 1000, 500, 1000)
      setSound(ringtoneUri(), audioAttrs())
    }
    nm.createNotificationChannel(channel)
  }

  @Suppress("DEPRECATION")
  private fun wakeScreenBriefly() {
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      val wakeLock = pm.newWakeLock(
        PowerManager.FULL_WAKE_LOCK or
          PowerManager.ACQUIRE_CAUSES_WAKEUP or
          PowerManager.ON_AFTER_RELEASE,
        "$packageName:incoming-call"
      )
      wakeLock.acquire(10_000)
    } catch (e: Exception) {
      Log.w(TAG, "wake lock failed", e)
    }
  }

  private fun openActivityIfLockedOrScreenOff(intent: Intent) {
    try {
      val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      if (keyguard.isKeyguardLocked || !power.isInteractive) {
        startActivity(intent)
      }
    } catch (e: Exception) {
      Log.w(TAG, "startActivity from FCM failed", e)
    }
  }

  private fun ringtoneUri(): Uri =
    Uri.parse("android.resource://$packageName/raw/ringtone")

  private fun canUseFullScreenIntent(nm: NotificationManager): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      nm.canUseFullScreenIntent()
    } else {
      true
    }

  private fun audioAttrs(): AudioAttributes =
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

  private fun notificationId(callId: String): Int =
    callId.hashCode().let { if (it == Int.MIN_VALUE) 1 else kotlin.math.abs(it) }

  companion object {
    private const val TAG = "GhostelFCM"
  }

  private fun startRingingCallService(callId: String, callerName: String) {
    try {
      val serviceIntent = Intent(this, GhostelActiveCallService::class.java).apply {
        putExtra(GhostelActiveCallService.EXTRA_CALL_ID, callId)
        putExtra(GhostelActiveCallService.EXTRA_PEER_NAME, callerName)
      }
      ContextCompat.startForegroundService(this, serviceIntent)
    } catch (e: Exception) {
      Log.w(TAG, "start foreground call service failed callId=$callId", e)
    }
  }
}
