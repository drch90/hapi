# Fork updates

This page records upstream synchronization and deployment of the local extensions
in this fork. Build from source to include them; see
[deployment](./deployment.md#upgrading-a-source-build-with-pm2).

## 2026-11-03: upstream v0.34.0

Merged [upstream v0.34.0](https://github.com/tiann/hapi/releases/tag/v0.34.0)
(`1f4518df`) into the local history at `6cd25494`. Both histories are retained,
including all 88 files added locally since the shared v0.33.5 base.

### Preserved local capabilities

| Area | Integration retained in this merge |
| --- | --- |
| [Hermes](./agents.md#hermes-agent) | ACP creation/resume, provider/model discovery, permission controls, commands and live steering across CLI, hub, Web and Android. Original-machine and namespace checks remain in place alongside upstream DSH native resume. |
| Message delivery | Claude's durable UUID-based steering acknowledges native receipt, keeps uncertain delivery explicit and avoids automatic replay. Local queue isolation and model selection coexist with upstream live effort changes and tool-result images. |
| Android composer | Native reference chips, selection, copy/paste and focus now use upstream session/file suggestions. Scheduled drafts stay persisted until acceptance; retries retain the original timestamp, and delayed responses cannot clear a newer schedule choice. |
| Android chat | Status/context details, provider-aware Pi context budgets, transcript scrolling, outline navigation, sharing and file actions remain available alongside upstream usage metadata and question cards. Local media playback, gallery and cancellable downloads gain file-opening support. |
| Session list and notifications | Global pins, workspace grouping/collapse, search/filter preferences, manual unread, Mark all read and background notifications remain integrated with upstream presence, connection and runner-version indicators. |

### Verification

Checks used **Bun 1.4.4**, matching the repository's pinned version.

| Check | Result for the merged source |
| --- | --- |
| Frozen dependency install and `bun typecheck` | Passed for CLI, Web, hub and relay. |
| Hub, shared and relay suites | 1,637, 397 and 118 passed respectively; 3 optional hub integration tests skipped. |
| Web suite | 3,997 passed initially. The remaining Hermes launch test needed the upstream QueryClient wrapper; all 79 tests in that file passed after the fix. |
| CLI suite | 4,009 passed, 22 skipped; 4 difftastic failures caused by the host's older glibc, as in the previous merge. |
| Runner integration | 25 passed, 1 skipped, using an isolated temporary hub and process registry. |
| Web browser regressions | 31 passed: attachment picker, composer image preview, preview Back navigation and session-list fork menus. |
| `bun run gen:fixtures` | 82 chat, 14 SSE and 15 pagination fixtures plus mode data regenerated without drift. |
| Web and hub builds | Passed, including embedded Web asset generation. |
| Android static review | XML, resource references, all 798 English/Chinese/Russian string keys and placeholders, duplicate declarations/arguments and Kotlin syntax differences checked. |

Android/iOS compilation, instrumentation and native conformance remain
unverified: this host has no JDK/Android SDK or Swift/Xcode. Static review does
not replace those checks. The difftastic executable requires unavailable
`GLIBC_2.32`, `GLIBC_2.33` and `GLIBC_2.34`; its wrapper and tests are unchanged.

This update covers the local source merge and verification. No remote push,
release, installation or service restart was performed for v0.34.0.

## 2026-11-01: upstream v0.33.5

Merged [upstream v0.33.5](https://github.com/tiann/hapi/releases/tag/v0.33.5)
(`ba2b5c56`) into the existing local history at `0fe27073`. The resulting merge is
[`80279a30`](https://github.com/drch90/hapi/commit/80279a30ce88ecc2b40ef3748f15519b2710f457).
Both histories remain ancestors of the merge, and all 87 files added by the local
changes since the shared v0.32.0 base remain present.

### Preserved local capabilities

| Area | Integration retained in this merge |
| --- | --- |
| [Hermes](./agents.md#hermes-agent) | ACP creation/resume, provider/model discovery, permission controls, native commands and live steering. Resume uses the shared upstream request coalescing while retaining namespace and original-machine checks. |
| Message delivery | Claude and Hermes steering, durable queues, scheduled messages and explicit handling of uncertain delivery results. |
| [Session list](./session-list.md) | Search/filter preferences, grouping and pinning. Workspace recency follows the latest user input, with creation time as fallback. |
| Web chat | Session-reference chips, draft restoration, scheduling and workspace navigation, integrated with upstream share import. Transcript scrolling and inspection coexist with read receipts from the rendered tail. |
| [Android](./native-apps.md) | Session menus, search/grouping, references, scheduling, workspace/file actions, status/context indicators and Hermes controls. Manual unread and Mark all read now use the upstream revision-based read state while retaining local preferences and the durable outbox. |

### Build and deployment

The merged source was packaged with **Bun 1.4.4** for
`bun-linux-x64-baseline`, including the CLI, hub and embedded Web app. The package
is named `hapi-v0.33.5-80279a30-linux-x64.tar.gz`.

The existing PM2 hub and runner were replaced with this build. Before cutover,
the new executable was tested against an isolated database copy; schema migration
from version 27 to 30 preserved every row and pre-existing column value across
the original tables. A second SQLite backup was taken with the live hub stopped
immediately before replacement.

Existing agent processes survived the runner restart and reconnected. Their
session registrations were restored after verifying the process IDs and start
markers. The CLI version, PM2 ownership, workspace roots, authentication, message
history and embedded Web assets were verified. Settings, credentials and the
custom Codex launcher were retained, and other PM2 services were unchanged.

Build records and private rollback files remain on the deployment machine under
`~/.hapi/deployments/v0.33.5-80279a30/`. The original executable, launcher, package
metadata and configuration are in `backup/`; the final database snapshot is
`backup/cutover/hapi.db`. These private backups are kept outside Git.

### Verification

| Check | Result for the merged source/build |
| --- | --- |
| Frozen dependency install and `bun typecheck` | Passed. |
| Hub, Web, shared and relay suites | Passed. |
| CLI peer-delivery and Codex client tests | Passed. The Codex client tests were rerun with `HAPI_CODEX_APP_SERVER_BIN` unset so they used the test fixture executable. |
| CLI runner integration | 25 passed, 1 skipped. |
| `bun run gen:fixtures` | Regenerated without fixture drift. |
| Android translations | English, Simplified Chinese and Russian keys/placeholders checked for consistency. |
| All-in-one build and isolated migration | Passed with Bun 1.4.4. |
| Live deployment | Hub and runner online; existing session processes, history, settings and credentials preserved. Embedded index and seven referenced assets matched the build. |

The full CLI suite still has four difftastic failures on this host because the
bundled Linux binary requires a newer glibc. Android/iOS builds and native
conformance remain unverified for this merge: the host lacked a JDK/Android SDK
and Swift/Xcode. This deployment covers the Linux services and embedded Web app.
