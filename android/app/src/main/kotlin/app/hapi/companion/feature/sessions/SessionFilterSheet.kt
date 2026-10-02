package app.hapi.companion.feature.sessions

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.*
import androidx.compose.runtime.*
import java.time.Instant
import java.time.ZoneOffset
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

@Composable
internal fun machineFilterLabel(filter: MachineFilterUi): String = when {
    filter.id == UNKNOWN_MACHINE_ID -> stringResource(R.string.sessions_filter_unknown_machine)
    filter.unnamed -> stringResource(R.string.sessions_machine_fallback, filter.label)
    else -> filter.label
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionFilterSheet(state: SessionListUiState, select: (String?) -> Unit, dismiss: () -> Unit, update: (SessionFilters) -> Unit = {}, clear: () -> Unit = {}) {
    var dates by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = dismiss) {
        Text(stringResource(R.string.sessions_filters), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.sessions_active_only), Modifier.weight(1f))
            Switch(state.filters.activeOnly, { update(state.filters.copy(activeOnly = it)) })
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.sessions_unread_only), Modifier.weight(1f))
            Switch(state.filters.unreadOnly, { update(state.filters.copy(unreadOnly = it)) })
        }
        TextButton(onClick = { dates = true }) { Text(stringResource(R.string.sessions_date_range) +
            (state.filters.start?.let { " · $it – ${state.filters.end ?: it}" } ?: "")) }
        TextButton(onClick = clear) { Text(stringResource(R.string.sessions_clear_filters)) }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp).selectableGroup().testTag("session-filters")) {
            item("all") {
                FilterOption(stringResource(R.string.sessions_filter_all), state.activeMachineFilter == null) { select(null) }
            }
            items(state.machineFilters, key = { it.id }) { filter ->
                FilterOption("${machineFilterLabel(filter)} · ${filter.sessionCount}", state.activeMachineFilter == filter.id) { select(filter.id) }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
    if (dates) {
        val picker = rememberDateRangePickerState(
            initialSelectedStartDateMillis = state.filters.start?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli(),
            initialSelectedEndDateMillis = state.filters.end?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli())
        DatePickerDialog(onDismissRequest = { dates = false },
            confirmButton = { TextButton(onClick = {
                update(state.filters.copy(
                    start = picker.selectedStartDateMillis?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() },
                    end = (picker.selectedEndDateMillis ?: picker.selectedStartDateMillis)?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }))
                dates = false
            }) { Text(stringResource(R.string.chat_link_open)) } },
            dismissButton = { TextButton(onClick = { dates = false }) { Text(stringResource(R.string.chat_cancel)) } }) {
            DateRangePicker(picker, modifier = Modifier.heightIn(max = 480.dp), showModeToggle = true)
        }
    }

}

@Composable
private fun FilterOption(label: String, selected: Boolean, select: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = select)
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}
