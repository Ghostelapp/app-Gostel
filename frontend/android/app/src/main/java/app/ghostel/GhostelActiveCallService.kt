package app.ghostel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

class GhostelActiveCallService : Service() {
  override fun onCreate() {
    super.onCreate()
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val peerName = intent?.getStringExtra(EXTRA_PEER_NAME).orEmpty().ifBlank { "Ghostel" }
    val openAppIntent = Intent(this, MainActivity::class.java).apply {
      this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      NOTIFICATION_ID,
      openAppIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    val notification = builder
      .setSmallIcon(android.R.drawable.sym_call_outgoing)
      .setContentTitle("Ghostel")
      .setContentText("Aktywne połączenie z $peerName")
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(pendingIntent)
      .build()

    startForeground(NOTIFICATION_ID, notification)
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Active Ghostel calls",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Keeps an active Ghostel call running in the background"
        setSound(null, null)
        enableVibration(false)
      }
    )
  }

  companion object {
    const val EXTRA_CALL_ID = "call_id"
    const val EXTRA_PEER_NAME = "peer_name"
    private const val CHANNEL_ID = "ghostel_active_calls_v1"
    private const val NOTIFICATION_ID = 9471
  }
}
