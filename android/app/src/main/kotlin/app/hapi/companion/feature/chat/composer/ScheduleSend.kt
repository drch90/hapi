package app.hapi.companion.feature.chat.composer

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** Stored selection; relative presets are resolved once, when sending, never on retry. */
data class SendSchedule(val delayMinutes: Int? = null, val epochMs: Long? = null) {
    init { require((delayMinutes == null) != (epochMs == null)) }
    fun resolve(now: Long): Long = delayMinutes?.let { now + it * 60_000L } ?: requireNotNull(epochMs)
    fun encode(): String = delayMinutes?.let { "preset:$it" } ?: "at:$epochMs"
    companion object {
        fun decode(value: String?): SendSchedule? = when {
            value?.startsWith("preset:") == true -> value.substringAfter(':').toIntOrNull()?.takeIf { it in listOf(5, 30, 60, 240) }?.let { SendSchedule(delayMinutes = it) }
            value?.startsWith("at:") == true -> value.substringAfter(':').toLongOrNull()?.let { SendSchedule(epochMs = it) }
            else -> null
        }
        fun valid(at: Long, now: Long): Boolean = at >= now - 30_000L && at <= now + 7 * 24 * 60 * 60_000L
    }
}

@Composable
internal fun scheduleLabel(schedule: SendSchedule): String = schedule.delayMinutes?.let {
    stringResource(R.string.chat_schedule_preset, it)
} ?: stringResource(R.string.chat_schedule_at, DateTimeFormatter.ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(requireNotNull(schedule.epochMs))))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ScheduleSendPicker(onDismiss: () -> Unit, onSelect: (SendSchedule?) -> Unit) {
    var specific by remember { mutableStateOf(false) }
    var timeStep by remember { mutableStateOf(false) }
    var dateMillis by remember { mutableStateOf<Long?>(null) }
    var invalid by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(R.string.chat_schedule), style = MaterialTheme.typography.titleLarge)
            listOf(5, 30, 60, 240).forEach { minutes -> TextButton(onClick = { onSelect(SendSchedule(delayMinutes = minutes)); onDismiss() }) {
                Text(stringResource(R.string.chat_schedule_preset, minutes))
            } }
            TextButton(onClick = { specific = true }) { Text(stringResource(R.string.chat_schedule_specific)) }
            TextButton(onClick = { onSelect(null); onDismiss() }) { Text(stringResource(R.string.chat_schedule_clear)) }
        }
    }
    if (specific) {
        val date = rememberDatePickerState()
        DatePickerDialog(onDismissRequest = { specific = false }, confirmButton = {
            TextButton(enabled = date.selectedDateMillis != null, onClick = { dateMillis = date.selectedDateMillis; specific = false; timeStep = true }) { Text(stringResource(R.string.chat_link_open)) }
        }) { DatePicker(date) }
    }
    if (timeStep) {
        val now = java.time.LocalTime.now()
        val time = rememberTimePickerState(now.hour, now.minute, true)
        AlertDialog(onDismissRequest = { timeStep = false }, text = {
            Column { TimeInput(time); if (invalid) Text(stringResource(R.string.chat_schedule_invalid), color = MaterialTheme.colorScheme.error) }
        }, confirmButton = { TextButton(onClick = {
            val day = Instant.ofEpochMilli(requireNotNull(dateMillis)).atZone(ZoneOffset.UTC).toLocalDate()
            val at = day.atTime(time.hour, time.minute).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            if (SendSchedule.valid(at, System.currentTimeMillis())) { onSelect(SendSchedule(epochMs = at)); timeStep = false; onDismiss() } else invalid = true
        }) { Text(stringResource(R.string.chat_schedule)) } })
    }
}
