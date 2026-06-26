package app.ghostel
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle
import android.content.Intent
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  private var privacyOverlay: View? = null
  private var incomingCallWindowUntilMs: Long = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    applyIncomingCallWindowFlags(intent)
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    applyIncomingCallWindowFlags(intent)
  }

  override fun onPause() {
    if (!isIncomingCallWindowActive()) {
      addPrivacyOverlay()
    }
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    removePrivacyOverlay()
    markActivityResumed(isIncomingCallWindowActive())
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  private fun applyIncomingCallWindowFlags(intent: Intent?) {
    if (intent?.action != GhostelCallNotificationModule.ACTION_INCOMING_CALL ||
      intent.getBooleanExtra("ghostel_incoming_call", false) != true ||
      intent.getStringExtra("call_id").isNullOrBlank() ||
      intent.getStringExtra("caller_id").isNullOrBlank() ||
      !IncomingCallIntentSecurity.isValid(this, intent)
    ) {
      incomingCallWindowUntilMs = 0L
      return
    }

    synchronized(MainActivity::class.java) {
      pendingIncomingCallIntent = Intent(intent)
    }
    incomingCallWindowUntilMs = System.currentTimeMillis() + INCOMING_CALL_WINDOW_MS

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
          WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      )
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  private fun isIncomingCallWindowActive(): Boolean =
    incomingCallWindowUntilMs > System.currentTimeMillis()

  private fun addPrivacyOverlay() {
    if (privacyOverlay != null) return
    val decor = window.decorView as? ViewGroup ?: return
    privacyOverlay = View(this).apply {
      setBackgroundColor(Color.rgb(15, 20, 25))
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    decor.addView(
      privacyOverlay,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
  }

  private fun removePrivacyOverlay() {
    val overlay = privacyOverlay ?: return
    (overlay.parent as? ViewGroup)?.removeView(overlay)
    privacyOverlay = null
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }

  companion object {
    private const val INCOMING_CALL_WINDOW_MS = 2 * 60 * 1000L
    private var pendingIncomingCallIntent: Intent? = null
    private var pendingResumeAtMs: Long = 0L
    private var pendingResumeIncomingWindowActive: Boolean = false

    fun consumePendingIncomingCallIntent(): Intent? =
      synchronized(MainActivity::class.java) {
        val intent = pendingIncomingCallIntent
        pendingIncomingCallIntent = null
        intent
      }

    fun markActivityResumed(incomingWindowActive: Boolean) {
      synchronized(MainActivity::class.java) {
        pendingResumeAtMs = System.currentTimeMillis()
        pendingResumeIncomingWindowActive = incomingWindowActive
      }
    }

    fun consumePendingResumeEvent(): ResumeEvent? =
      synchronized(MainActivity::class.java) {
        if (pendingResumeAtMs <= 0L) return@synchronized null
        val event = ResumeEvent(pendingResumeAtMs, pendingResumeIncomingWindowActive)
        pendingResumeAtMs = 0L
        pendingResumeIncomingWindowActive = false
        event
      }
  }
}

data class ResumeEvent(
  val resumedAtMs: Long,
  val incomingWindowActive: Boolean,
)
