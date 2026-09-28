package app.hapi.companion.notifications

import android.content.Context
import app.hapi.data.push.LocalNotificationLedger
import app.hapi.protocol.wire.HapiJson
import java.security.MessageDigest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString

internal enum class ReceptionStatus { Stopped, Connecting, Connected, Reconnecting, PermissionRequired, PairingRequired, StartFailed }

internal class LocalNotificationSettings(context: Context) {
    private val prefs = context.getSharedPreferences("local_notifications", Context.MODE_PRIVATE)
    private val mutableEnabled = MutableStateFlow(prefs.getBoolean("enabled", false))
    val enabled = mutableEnabled.asStateFlow()
    val status = MutableStateFlow(ReceptionStatus.Stopped)

    fun setEnabled(value: Boolean) {
        prefs.edit().putBoolean("enabled", value).apply()
        mutableEnabled.value = value
    }

    fun ledger(hub: String): LocalNotificationLedger {
        val raw = prefs.getString("seen-${hubKey(hub)}", null)
        val entries = raw?.let { runCatching { HapiJson.decodeFromString<Map<String, Long>>(it) }.getOrNull() }.orEmpty()
        return LocalNotificationLedger(entries)
    }

    fun saveLedger(hub: String, ledger: LocalNotificationLedger) {
        prefs.edit().putString("seen-${hubKey(hub)}", HapiJson.encodeToString(ledger.snapshot())).apply()
    }
}

internal fun hubKey(hub: String): String = MessageDigest.getInstance("SHA-256")
    .digest(hub.toByteArray()).joinToString("") { "%02x".format(it) }
