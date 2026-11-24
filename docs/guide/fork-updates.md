# Fork updates

This page records upstream synchronization and deployment of the local extensions
in this fork. Build from source to include them; see
[deployment](./deployment.md#upgrading-a-source-build-with-pm2).

## 2026-11-24: upstream v0.36.7

Merged [upstream v0.36.7](https://github.com/tiann/hapi/releases/tag/v0.36.7)
(`4e36c995`) into `android-session-parity` from local tip `9bd1248a`, including
the intervening v0.36.6 release. Both histories and all 122 files added locally
relative to upstream v0.36.5 are retained. The original tip remains at
`backup/pre-upstream-v0.36.7-20261124`.

Merge `514048c7` and Android test-repository fix `2e660e4b` were pushed to the
fork. Android APK run 70 passed, and the hub and runner were deployed as
described below.

### Integrated capabilities

| Area | Integration retained in this merge |
| --- | --- |
| Upstream features and fixes | Input translation, Claude conversation history and round accounting, reusable clear/compact turns, ACP tool-call lifetimes, network recovery, read receipts and cached-tail rendering are included. |
| Agents and permissions | Hermes creation/resume, model/provider discovery, commands and approvals are incorporated into the upstream flavor trait table. Antigravity keeps the native terminal, Auto/Plan modes, steering and the retained ACP fallback. OpenCode keeps the local steering version gate and effective-model comparison. |
| Claude delivery | Local UUID/native-echo acknowledgement, one-message queue delivery and explicit resolution of uncertain writes remain. Confirmed steered prompts also become upstream fork/rewind history targets. The native terminal manager remains because Antigravity still uses it; unused legacy Codex launchers follow the upstream removal. |
| Web and native clients | Local pins, grouping, search, references, scheduling, workspace/media actions, transcript inspection and notifications remain. Android adds the upstream grouping toggle, disambiguated Windows/project paths, chat restoration and input translation. Local fold defaults and saved overrides coexist with the new flat layout; archived sessions retain job progress without returning to the in-progress group, and exports and outlines retain the original translated prompt. |
| Distribution | Only the existing Android APK workflow remains, byte-for-byte identical to the original tip, preserving fixed signing and the increasing version-code sequence. |

### Verification

Checks and builds used the pinned **Bun 1.4.4**.

| Check | Result |
| --- | --- |
| Frozen dependency install and typechecks | Passed for CLI, Web, hub and relay. |
| Hub, Web, shared and relay suites | 2,313 / 4,984 / 642 / 118 passed. Hub skipped three optional real-agent cases; Web retained one expected failure. |
| CLI suite | 6,311 passed and 46 skipped in the full run. All 12 failures outside difftastic passed after the Claude test doubles were updated, the Codex launcher environment override was removed for its tests, and Cursor permission tests ran without root DAC bypass. Four host-limited difftastic cases remain. |
| Runner integration | 25 passed, one skipped, using isolated temporary processes and a temporary hub. |
| Claude wire contract | All 49 tests passed. The 18 generated scenario baselines preserve local initialization/steering state; agent input and decoded chat output match upstream, apart from the additional synchronization step in the CAS fake agent. |
| Browser regressions | 223 Chromium scenarios passed. The staged touch-pull feedback case fails at the same assertion on the isolated pre-merge `9bd1248a` source with its own frozen dependency install. |
| Fixtures | 92 chat, 14 SSE and 15 pagination fixtures plus the mode catalog regenerated; a second generation had no drift. |
| Builds | CLI, Web, embedded assets, hub, the Linux all-in-one executable, website, documentation and static passkey site passed. The executable reports version 0.36.7. |
| Android static checks | Conflict resolutions, imports, interface calls and regression sources inspected. All four locales have 878 matching resource keys, valid XML, unique names and matching placeholders. The retained APK workflow is unchanged. |
| Android remote preflight and APK | [Actions run 70](https://github.com/drch90/hapi/actions/runs/45330101864) passed on `2e660e4b`: app, unit-test and instrumentation-test sources compiled; protocol/data/app tests and lint passed before APK assembly. APK identity, version code 70 and fixed certificate verification passed before upload. |

The bundled difftastic is unchanged and requires unavailable `GLIBC_2.32`,
`GLIBC_2.33` and `GLIBC_2.34`. The full CLI and browser suites are therefore
not reported as green. No Android Gradle tasks, native compilation, unit tests,
lint, SDK setup or emulators ran on this service host. CI compiled
instrumentation sources without running device tests; device behavior and
iOS compilation remain unverified.

### Android APK

The first remote run, 69, compiled the app and test sources and passed
protocol/data tests and lint. Five Robolectric test classes could not start
because their Android runtime download received HTTP 429 from Maven Central.
Commit `2e660e4b` directs Robolectric's separate runtime resolver to the same
canonical Maven Central endpoint used by Gradle. Run 70 then passed the full
preflight and produced the
[signed APK artifact](https://github.com/drch90/hapi/actions/runs/45330101864/artifacts/14891233613).
It retains `run.hapi.companion`, the fixed signing certificate and increasing
version code 70, allowing an update over the previous APK with that signing
identity. Artifacts are retained for seven days.

### Service deployment

The Linux executable from `514048c7` was checked on an isolated loopback hub
with a database copy, a fresh test token and disabled push/tunnel services.
All 330 sessions and 183,950 messages in that snapshot were retained;
authentication, sample histories, embedded assets and SQLite integrity passed.
The later Android-only build configuration fix does not change this service
executable.

The production hub and supervised runner were upgraded from **0.36.5 to
0.36.7**. Persistent rollback material, including the final consistent database
backup, original executable and package metadata, settings, JWT secret and
owner identity, is stored at
`/root/.hapi/deployments/v0.36.7-514048c74dc5/` with private directory access.
The database remains at schema 36.

The new hub passed health and existing-JWT checks 4.34 seconds after the
switch began; the replacement runner was ready after 5.85 seconds. Preserving
the executable's mtime prevented a competing version handoff. The runner
exited through its own control endpoint and PM2 started its replacement.
Its workspace root, custom launchers and PM2 supervision were preserved.

All six sessions live at the start of the switch reconnected. Their six
wrappers, six native agent processes and four MCP processes kept their PIDs,
start markers and executable device/inode identities. All six runner
registrations were restored from verified live metadata. Every one of the
330 session IDs and 184,315 message IDs in the final pre-switch backup remains
present. Settings, JWT/owner keys, custom launchers and the PM2 dump are
unchanged.

Existing wrappers continue running their original code; new sessions use
the updated CLI. The deployed executable SHA-256 is
`6409e2a7a752bf8e4b8e5060812e7eed7aa9a0b7b428c70676aac81a4e559b19`.

## 2026-11-19: upstream v0.36.5

Merged [upstream v0.36.5](https://github.com/tiann/hapi/releases/tag/v0.36.5)
(`590a9533`) into `android-session-parity` from the local `aa8e6bf8` tip.
Merge commit `a3e4bd12` was pushed to the fork. Both histories and all 122
files added locally since v0.36.4 are retained; the pre-merge tip remains at
`backup/pre-upstream-v0.36.5-20261119`.

### Preserved local capabilities

| Area | Integration retained in this merge |
| --- | --- |
| Agents and commands | Antigravity keeps its native terminal as the default transport and a separate fallback command catalog for the retained ACP transport. Hermes keeps native resume, model/provider discovery, command input hints and the distinction between an unadvertised and an explicitly withdrawn command catalog. |
| Delivery and steering | Claude keeps UUID/native-echo steering reconciliation. The shared queue retains local batch limits, dequeue hooks and waiter/reset behavior alongside upstream abort guards, deferred acknowledgements and in-flight cancellation tracking. |
| Web and Android | Local session grouping, search, pins, read state, references, scheduling, workspace/media actions, stop controls and notifications remain. Upstream passkey sign-in and Japanese support are integrated; Japanese includes the local extensions. Android's malformed-address test uses an incomplete URL so it preserves the fork's HTTP pairing behavior. |
| Distribution | Only the existing Android APK workflow remains, with the same fixed signing certificate and increasing version-code sequence. |

### Verification

Checks and builds used the pinned **Bun 1.4.4**. Passing results from the
initial merge were retained when the relevant source and dependencies were
unchanged.

| Check | Result |
| --- | --- |
| Frozen dependency install and typechecks | Passed for CLI, Web, hub, relay and website. |
| Web, shared and relay suites | 4,769 / 565 / 118 passed; Web retained one expected failure. |
| Hub suite | 2,229 passed in the full run. The three files affected by sandbox home/socket restrictions passed all 29 tests when rerun on the host. |
| CLI suite | 6,207 passed and 46 skipped in the full run; five failures remain as described below. The focused Hermes follow-up passed. |
| Runner integration | 25 passed, one skipped, with temporary processes and a temporary hub. |
| Browser regressions | 205 Chromium scenarios passed; staged touch-pull feedback failed. The current baseline attempt failed earlier while waiting for its viewport, so it does not establish a same-assertion reproduction. |
| Passkeys | Chromium WebAuthn registration, browser/native sign-in, callback and PKCE checks passed. |
| Fixtures | 91 chat, 14 SSE and 15 pagination fixtures plus catalogs regenerated without drift. |
| Builds | CLI, Web, embedded assets, hub, Linux all-in-one executable, website, documentation and static passkey site passed. |
| Android static checks | Four locales have 869 matching resource keys, no duplicate names, matching per-quantity placeholders and valid XML. Seven signing-helper tests passed. |
| Android remote preflight and APK | [Actions run 68](https://github.com/drch90/hapi/actions/runs/44351908296) passed on `a3e4bd12`: app, unit-test and instrumentation-test sources compiled; protocol/data/app unit tests and lint passed before APK assembly. APK identity, version code 68 and fixed certificate verification passed before upload. |

Four CLI failures are the unchanged bundled difftastic's requirements for
unavailable `GLIBC_2.32`, `GLIBC_2.33` and `GLIBC_2.34`. The unchanged OpenCode
storage scanner had one timeout in the full run and two timing-sensitive
failures in its focused rerun; these limitations were also recorded for
v0.36.4. The staged touch-pull browser failure was previously recorded, but
this update does not claim that the full CLI or browser suite is green.

No Android Gradle tasks, SDK setup or emulator execution ran on the service
host. Actions compiled instrumentation sources without running device tests;
device behavior and iOS compilation remain unverified.

### Service deployment

The source-built Linux executable was first checked on an isolated loopback
hub with a database copy, fresh test token and disabled push/tunnel services.
It preserved all 307 sessions and 173,464 messages in that earlier snapshot;
authentication, sample histories, embedded assets and SQLite integrity passed.

The production hub and supervised runner were upgraded from **0.36.4 to
0.36.5**. Persistent rollback material, including the final consistent database
backup, original executables/package metadata, settings, JWT secret and owner
identity, is stored on the service host at
`/root/.hapi/deployments/v0.36.5-a3e4bd122ceb/` with private directory access.
The database stayed at schema 36.

The hub passed health and existing-JWT checks about four seconds after the
switch began; the new runner was ready in about five seconds. The executable's
mtime was preserved during the controlled swap to prevent a competing runner
handoff. The runner exited through its local control endpoint and PM2 started
the replacement. Its workspace root and custom Codex launcher were retained.

All five active sessions reconnected. Their four wrappers, four native agent
processes and three MCP processes retained their PIDs, start markers and
executable device/inode identities. All five runner registrations, including
both Codex roots sharing a wrapper, were restored from verified live metadata.
Every one of the 173,901 message IDs in the final pre-switch backup remained
present. Settings, JWT/owner keys, custom launchers and the PM2 dump were
unchanged; both services remained under PM2 supervision.

Existing wrappers continue running their original code; new sessions use
the updated CLI. The deployed executable SHA-256 is
`19ca40ea70eec433c2ed2124d0045d03f8e3a560ecdcda5ebd91d03dcb4b5425`.

## 2026-11-17: upstream v0.36.4

Merged [upstream v0.36.4](https://github.com/tiann/hapi/releases/tag/v0.36.4)
(`825af9ba`) into `android-session-parity` from the local `9b4149d7` tip.
Both histories and all 121 files added locally since v0.34.6 are retained.
The pre-merge tip is also saved as `backup/pre-upstream-v0.36.4-20261117`.
This update is a local source merge; no push or service deployment was performed.

### Preserved local capabilities

| Area | Integration retained in this merge |
| --- | --- |
| Agents | Hermes creation, resume, model/provider discovery and permission controls remain integrated with upstream lazy command loading and resume checks. Antigravity keeps its native terminal, commands, context/quota reporting and steering. |
| Delivery and steering | Claude retains UUID/native-receipt reconciliation and isolated queue consumption; successful steering also dismisses upstream pending permissions. OpenCode retains model equivalence and its v2 steering version gate alongside upstream rewind gating. Dispatching, uncertain delivery, cancellation and explicit retry remain distinct. |
| Web and Android | Session grouping, pins, search/filter preferences, unread state, media and workspace actions remain available. Android retains native reference editing, scheduling, stop controls, transcript navigation, tool details and background notifications with the upstream composer and visual updates. |
| Android distribution | Only the fork's Android APK workflow is retained. Its fixed signing certificate and increasing workflow version-code override are preserved alongside upstream git-count fallback for other builds. |

### Verification

Checks and the source build used the pinned **Bun 1.4.4**.

| Check | Result |
| --- | --- |
| Frozen dependency install and root typecheck | Passed; CLI, Web, hub and relay typechecks passed. |
| Hub, Web, shared and relay suites | 2,105 / 4,698 / 499 / 118 passed. Three optional hub tests were skipped; Web retained one expected failure. |
| CLI suite | 5,926 passed in the full run. All 89 focused command/resume, Claude launcher/steering and Cursor permission tests passed after reconciliation; the remaining host limitations are described below. |
| Runner integration | 25 passed, one skipped, using temporary processes and a temporary hub. |
| Browser regressions | 196 distinct Chromium scenarios passed across the full run and focused follow-up. Modal-background queries and the scratchlist fixture were reconciled with upstream interfaces. Two history-loading failures also reproduce on the isolated pre-merge source. |
| Passkeys | Real Chromium WebAuthn registration, browser-to-native login, native-to-browser discovery, redirect callback and PKCE passed. The test now intercepts the actual 303 callback through CDP because Playwright routes omit redirected requests. |
| Fixtures | 91 chat, 14 SSE and 15 pagination fixtures plus catalogs regenerated; final generation had no drift. |
| Build | CLI, Web, embedded assets and hub build passed. |
| Android static checks | Changed Kotlin syntax, XML/resources and local integrations inspected; all three locales have 870 matching resource keys with no duplicates or placeholder mismatches. Seven signing-helper tests passed. |

The bundled difftastic still requires unavailable `GLIBC_2.32`, `GLIBC_2.33`
and `GLIBC_2.34`, leaving four CLI cases failing on this host. The unchanged
OpenCode storage-scanner tests also have timing-sensitive failures on this
filesystem, where immediate writes can share the same modification time.
Cursor permission tests passed with root DAC override capabilities removed.

The two existing browser failures concern an upward history gesture during
cached re-entry and staged touch-pull feedback. They failed identically on
the pre-merge source with the same relevant dependency versions; this merge
does not claim the full browser suite is green.

Android compilation, unit tests, lint and device execution were not run on
this service host. The new stop-control regression and native conformance
remain for remote verification under the repository's Android policy.
iOS compilation and other platform-specific checks were not run.

## 2026-11-11: Android-only Actions

After re-enabling Actions on the fork, the workflow configuration was reduced
to **Android APK** on both `main` and `android-session-parity`. Other inherited
workflows, including automated review/merge, release and emulator jobs, were
removed. Automatic builds require Android/fixture changes on the development
branch; manual runs always build that branch. Workflow-only edits run only the
lightweight scope check.

APK builds now require a fixed private signing key in a repository Actions
secret, verify its public certificate and use an increasing version code.
Signature continuity starts with the first build using that key; older ephemeral
CI signatures are not recovered. See [Android build and signing setup](https://github.com/drch90/hapi/blob/android-session-parity/android/README.md#fixed-apk-signing).
Compilation, unit tests and lint remain CI gates; the service host does not
run Android tests/Gradle or recreate a native toolchain. The upstream-sync
verification records below describe checks and workflows at that time.

## 2026-11-11: upstream v0.34.6

Merged [upstream v0.34.6](https://github.com/tiann/hapi/releases/tag/v0.34.6)
(`92da7846`) from the local `150de900` tip. Both histories and all 118 files
added locally since v0.34.0 are retained.

### Preserved local capabilities

| Area | Integration retained in this merge |
| --- | --- |
| Antigravity | The persistent native terminal remains the default, including Auto, Plan, permissions, commands, context/quota reporting and receipt-based steering. Upstream ACP and legacy transport modules remain available in the source. |
| OpenCode | Upstream v1/v2 steering retains the local v2 version gate, equivalent default/model selection, and `resume: false` admission so a late steer cannot start an untracked turn. |
| Hermes | Creation/resume, model/provider discovery, permission modes, commands and steering remain integrated across clients. Upstream peer reply forwarding recognizes Hermes completion events. |
| Message delivery | Dispatching remains distinct from an unknown outcome. Cancellation tombstones, explicit retry, late receipt reconciliation and stale-response protection remain intact. Peer reply waiting recognizes dispatching rows. |
| Web and Android | Local grouping, pins, search/filter preferences, unread state, composer references, scheduling, media and workspace actions coexist with upstream sorting, presence, attached jobs and gap recovery. Local Android completion notifications remain available. |

### Verification

Checks and the Linux build used the pinned **Bun 1.4.4**.

| Check | Result |
| --- | --- |
| Frozen dependency install and `bun typecheck` | Passed for CLI, Web, hub and relay. |
| Hub, shared and relay suites | 1,807, 457 and 118 passed; 3 optional hub integration tests skipped. The final delivery-owner guard also passed all 42 focused tests. |
| Web suite | 4,422 passed initially; all 75 tests in the four affected files passed after the queue UI and mode assertions were reconciled. |
| CLI suite | 5,100 passed in the full run. Follow-up runs passed all 69 affected lifecycle/command tests and 118 peer tests. Cursor permission cases passed under a non-root user. Four difftastic cases remain limited by the host's older glibc. |
| Runner integration | 25 passed, 1 skipped, using isolated temporary processes and a temporary hub. |
| Browser regressions | All 82 workflow-selected Chromium cases passed across the full run and a focused retry. One share-export case exhausted its 30-second budget during the loaded full run, then passed unchanged in 5.2 seconds in isolation. |
| Fixtures | 91 chat, 14 SSE and 15 pagination fixtures plus catalogs regenerated; the final generation had no drift. |
| Android | App, unit-test and instrumentation-test sources compiled. Protocol/data/app suites passed 448/305/696 tests, and `lintDebug` passed using the existing JDK/SDK and locked offline dependencies. |
| Actions automation | All 58 review/merge automation tests passed. |
| Linux build and migration | CLI, hub and embedded Web build passed. An isolated candidate upgraded schema 30 to 34, preserving all original rows and column values except the three expected interrupted-turn recovery records. Authentication, five live-session histories and 12 embedded assets were verified. |

The bundled difftastic executable requires unavailable `GLIBC_2.32`,
`GLIBC_2.33` and `GLIBC_2.34`; its code and archive are unchanged. iOS compilation,
Windows execution, Docker-backed PowerShell checks and Android emulator tests
were not available locally. This service build reuses the verified installed
Linux tunwg asset; its integration is unchanged.

At the time of the upstream merge, the push to `android-session-parity` was
configured to trigger Test (including runner integration and Windows Codex MCP)
and Android (compile/unit/lint before APK and API 36 emulator jobs). Their
completion was also configured to trigger the Auto Merge observer, requiring
the repository owner's approval for that HEAD. The push did not publish a
release or deploy native applications.

### Service deployment

Deployed source merge [`b16d36db`](https://github.com/drch90/hapi/commit/b16d36db0b5276f1d3d18abee9ef69791e266a32)
to the existing PM2 installation. The launcher and platform package both report
**0.34.6** and record the source commit. Matching old package/database backups
and private verification records remain on the host.

Built the search index on a database copy before stopping the hub, then reconciled
the final consistent backup into that copy. All **13 original tables** matched
exactly before activation, retaining **285 sessions and 151,170 messages** while
upgrading schema **30 → 34**. A subsequent backup contained **151,226 messages**;
every original message remained unchanged, and no original rows were missing
from any of those tables. Live session and machine state continued updating.

The hub's measured availability gap was **10.5 seconds**. All **five session
wrappers, five native agent processes and six persistent bridge processes** kept
their original PIDs, process start times and executable inodes. All five sessions
reconnected, their histories loaded, and the original client JWT remained valid.
The live service also passed authentication rejection, message-content search
and byte-for-byte checks for all 12 embedded Web assets.

Used `hapi runner stop` for the supervised runner handoff, preserving the
custom Codex launcher, workspace roots, environment and PM2 ownership. Restored
all five runner registrations after verifying each original PID generation,
start marker and native session identity. Verification uses the hub's live
presence API because persisted presence is reset during startup. Settings,
login keys, the saved PM2 configuration and other PM2 applications were unchanged.
Existing wrappers continue their original code for the lifetime of their
sessions; newly started sessions use the updated CLI.

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

Android/iOS compilation, instrumentation and native conformance could not be
verified locally: this host has no JDK/Android SDK or Swift/Xcode. Static review does
not replace those checks. The difftastic executable requires unavailable
`GLIBC_2.32`, `GLIBC_2.33` and `GLIBC_2.34`; its wrapper and tests are unchanged.

### Build and deployment

The merged source at `ee21b3af` was built with **Bun 1.4.4** for
`bun-linux-x64-baseline`, including the CLI, hub and embedded Web app, and deployed
to the existing PM2 hub and runner on 2026-11-03.

An isolated startup against a database copy verified authentication, history,
all 245 sessions and the embedded index plus seven referenced assets. Schema
version 30 stayed unchanged. Every existing row and column value was preserved
except the three open turns that startup closed with `hub_restart` and the
expected ten-minute recovery deadline; their identities and other fields were
unchanged.

A final SQLite backup was taken with the live hub stopped. Hub health recovered
about 2.3 seconds after the stop request. The runner then exited through its
local shutdown endpoint, allowing PM2 to start the new build without terminating
agent processes. All four existing sessions and their eight wrapper/native
processes survived with unchanged process generations and native thread IDs.
Their runner registrations were restored after verifying live PID/start markers.
Existing agents continue running their originally loaded code; new launches use
v0.34.0.

Live verification confirmed that both service executables matched the build,
the runner remained under its PM2 supervisor with the original workspace roots,
and all sessions reconnected. SQLite integrity and foreign-key checks passed;
all 245 pre-cutover sessions and 105,970 pre-cutover messages remained, with every
existing message column unchanged. Pre-restart client authentication, settings,
credentials, custom Codex launcher, saved PM2 configuration and other PM2 services
were preserved. The embedded Web assets matched the build and the new PM2
stdout/stderr segments contained no errors. The runner's private debug log still
reports the pre-existing missing Cursor `agent` executable during optional model
discovery; that background probe does not block startup or the active Codex
sessions. Subsequent runner heartbeats confirmed stable service processes and
session registrations.

Private build records and rollback files are retained on the deployment host at
`~/.hapi/deployments/v0.34.0-ee21b3af/`. The original executable, launcher, package
metadata and configuration are in `backup/`; the final database snapshot is
`backup/cutover/hapi.db`. These files remain outside Git. The service deployment
itself did not push source or create a release. It covers the Linux services and
embedded Web app; native builds require CI or the corresponding platform
toolchains.

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
