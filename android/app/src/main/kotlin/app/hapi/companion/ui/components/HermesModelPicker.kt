package app.hapi.companion.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.HermesModelSummary

data class HermesModelsUi(
    val models: List<HermesModelSummary> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

fun groupHermesModels(models: List<HermesModelSummary>, search: String): Map<String, List<HermesModelSummary>> =
    models.filter { model -> listOfNotNull(model.modelId, model.name, model.providerLabel)
        .any { it.contains(search.trim(), ignoreCase = true) } }
        .groupBy { it.providerLabel ?: "Hermes" }.toSortedMap()

@Composable
fun HermesModelPicker(
    models: List<HermesModelSummary>,
    selected: String?,
    loading: Boolean,
    error: String?,
    disabled: Boolean,
    onSelect: (String) -> Unit,
    onRefresh: () -> Unit,
    allowDefault: Boolean = false,
) {
    var search by remember { mutableStateOf("") }
    val groups = remember(models, search) { groupHermesModels(models, search) }
    Column {
        Text(selected?.takeUnless { it == "auto" } ?: stringResource(R.string.hermes_model_default), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onRefresh, enabled = !disabled && !loading) { Text(stringResource(R.string.hermes_model_refresh)) }
        OutlinedTextField(value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.hermes_model_search)) }, singleLine = true)
        if (loading) Text(stringResource(R.string.chat_config_loading_models))
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
        if (allowDefault) TextButton(onClick = { onSelect("auto") }, enabled = !disabled) {
            Text(stringResource(R.string.hermes_model_default))
        }
        LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
            for ((provider, entries) in groups) {
                item(key = "provider:$provider") { Text(provider, style = MaterialTheme.typography.titleSmall) }
                items(entries, key = { "model:${it.modelId}" }) { model ->
                    TextButton(onClick = { onSelect(model.modelId) }, enabled = !disabled && !loading && error == null,
                        modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text((if (model.modelId == selected) "✓ " else "") + (model.name ?: model.modelId))
                            Text(model.modelId, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
        if (!loading && error == null && groups.isEmpty()) Text(stringResource(R.string.hermes_model_empty))
        if (allowDefault) OutlinedTextField(value = selected?.takeUnless { it == "auto" }.orEmpty(),
            onValueChange = { onSelect(it.ifBlank { "auto" }) }, enabled = !disabled,
            label = { Text(stringResource(R.string.hermes_model_manual)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    }
}
