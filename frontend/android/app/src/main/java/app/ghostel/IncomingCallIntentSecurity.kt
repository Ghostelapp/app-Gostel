package app.ghostel

import android.content.Context
import android.content.Intent
import java.util.UUID

object IncomingCallIntentSecurity {
  private const val PREFS = "ghostel_internal_intents"
  private const val TOKEN_KEY = "incoming_call_token"
  private const val TOKEN_EXTRA = "ghostel_internal_call_token"

  fun protect(context: Context, intent: Intent): Intent =
    intent.putExtra(TOKEN_EXTRA, token(context))

  fun isValid(context: Context, intent: Intent?): Boolean {
    val provided = intent?.getStringExtra(TOKEN_EXTRA).orEmpty()
    return provided.isNotBlank() && provided == token(context)
  }

  private fun token(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs.getString(TOKEN_KEY, null)?.let { return it }
    val created = UUID.randomUUID().toString()
    prefs.edit().putString(TOKEN_KEY, created).apply()
    return created
  }
}
