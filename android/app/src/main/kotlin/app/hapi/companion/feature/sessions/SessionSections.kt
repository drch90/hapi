package app.hapi.companion.feature.sessions

enum class SessionSectionKind { PINNED, IN_PROGRESS, ACTIVE, WORKSPACE }

data class SessionSectionUi(
    val id: String,
    val kind: SessionSectionKind,
    val rows: List<SessionRowUi>,
    val title: String? = null,
    val directory: String? = null,
    val machine: MachineFilterUi? = null,
    val collapsed: Boolean = false,
)

private data class WorkspaceKey(val machineId: String?, val directory: String?) {
    // Length prefixes keep machine/path boundaries unambiguous, including Windows paths.
    val id: String get() = "workspace:${machineId?.length ?: -1}:${machineId.orEmpty()}:${directory.orEmpty()}"
}

/** Global pins, running/attention, connected, then workspace history (web sidebar order). */
internal fun buildSessionSections(
    rows: List<SessionRowUi>,
    collapseOverrides: Map<String, Boolean> = emptyMap(),
    searching: Boolean = false,
): List<SessionSectionUi> {
    val globalPins = mutableListOf<SessionRowUi>()
    val inProgress = mutableListOf<SessionRowUi>()
    val active = mutableListOf<SessionRowUi>()
    val workspaces = linkedMapOf<WorkspaceKey, MutableList<SessionRowUi>>()
    for (row in rows) {
        val summary = row.summary
        when {
            summary.globalPinned == true -> globalPins.add(row)
            summary.pinned != true && summary.active -> {
                if (summary.thinking || summary.backgroundTaskCount > 0 || summary.pendingRequestsCount > 0) {
                    inProgress.add(row)
                } else {
                    active.add(row)
                }
            }
            else -> {
                val metadata = summary.metadata
                val directory = metadata?.worktree?.basePath?.takeIf { it.isNotEmpty() }
                    ?: metadata?.path?.takeIf { it.isNotEmpty() }
                val key = WorkspaceKey(metadata?.machineId, directory)
                workspaces.getOrPut(key) { mutableListOf() }.add(row)
            }
        }
    }

    val sections = buildList {
        if (globalPins.isNotEmpty()) add(SessionSectionUi("pinned", SessionSectionKind.PINNED, globalPins))
        if (inProgress.isNotEmpty()) add(SessionSectionUi("in-progress", SessionSectionKind.IN_PROGRESS, inProgress))
        if (active.isNotEmpty()) add(SessionSectionUi("active", SessionSectionKind.ACTIVE, active))
        val workspaceSections = workspaces.map { (key, group) ->
            SessionSectionUi(
                id = key.id,
                kind = SessionSectionKind.WORKSPACE,
                rows = group.sortedByDescending { it.summary.pinned == true },
                title = SessionListViewModel.projectLabel(group.first().summary),
                directory = key.directory,
                machine = group.first().machine,
            )
        }
        val searchOrder = rows.mapIndexed { index, row -> row.id to index }.toMap()
        addAll(workspaceSections.sortedWith(
            compareByDescending<SessionSectionUi> { section -> section.rows.any { it.summary.pinned == true } }
                .thenBy { section -> if (searching) section.rows.minOf { searchOrder.getValue(it.id) } else 0 }
                .thenByDescending { section -> section.rows.maxOf { it.summary.updatedAt } }
                .thenBy { it.id },
        ))
    }
    return sections.map { section ->
        val defaultCollapsed = section.kind == SessionSectionKind.WORKSPACE &&
            section.rows.none { it.summary.pinned == true }
        section.copy(collapsed = !searching && (collapseOverrides[section.id] ?: defaultCollapsed))
    }
}
