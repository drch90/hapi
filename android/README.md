# HAPI Android

Native Android client (Kotlin + Jetpack Compose) for the HAPI hub. Fully
independent from the web app; shares the
[client contract](../docs/api/client-contract/index.md) and the web-generated
golden fixtures (`shared/fixtures/`).

- **applicationId**: `run.hapi.companion` · **minSdk** 26 · **target/compileSdk** 36
- **Toolchain**: Gradle 8.14.2 (wrapper) · AGP 8.11.1 · Kotlin 2.1.21 · Compose BOM 2025.05.00 · JDK 17+ (CI uses 21)

## Current capabilities

The app provides sessions/chat, approvals and questions, new sessions,
attachments, files/Git, Scratchlist, standard dictation, usage/storage,
settings and encrypted-relay or direct-FCM notifications. Model and permission
controls follow agent/session capabilities; usage/storage require the owner
namespace. See the [native app guide](../docs/guide/native-apps.md) for platform
differences, pairing and features currently available through the web.

- **Sessions:** list long-press and chat overflow share Copy session reference,
  Mark unread, project/global pin, archive, rename, reopen/delete and New in same
  directory. Metadata search supports multiple terms and wildcards; filters cover
  machine, active/unread state and local calendar dates. Machine/active preferences
  and read watermarks persist per hub/device. Mark all read includes visible
  session records outside the current filters.
- **Session groups:** global pins precede In progress (thinking, background
  work or pending requests), Active, then workspace history. Workspace identity
  includes the machine and the worktree's base path. Project pins stay first
  in their workspace; other history groups start collapsed. Tap a header to
  expand/collapse it; choices survive chat navigation and refresh. Search
  temporarily expands matching groups without changing those choices.
- **Composer:** `@` finds other conversations with content and inserts atomic
  reference chips; drafts/copy/paste serialize full Markdown session links. Chat
  links open native conversations. Optimistic send, queue/steer, attachments,
  slash suggestions and dictation remain available. The clock schedules text
  for 5/30/60/240 minutes later or a local date/time within seven days, using the
  hub's durable queue. Scheduled sends cannot include attachments or steering.
- **Context usage:** below the composer, the compact Web-style label opens
  cache/used/remaining token details. It follows the latest parent-thread usage
  (excluding subagents), with warnings at 70%/90%. Reported limits take priority,
  then Pi's provider-qualified live/cached catalog, then Web's conservative
  Claude/Codex/Pi/Cursor budgets. Unknown limits show used tokens only; no usage
  report means no indicator. See the [usage calculation rules](../docs/api/client-contract/messages.md#context-usage).
- **Unknown deliveries:** Cancel dismisses a held unknown send on this device
  when the hub still reports it busy, matching Web. The dismissal survives
  refresh/restart; a later delivery acknowledgement appears in the transcript,
  while an explicit requeue makes the pending row visible again. Confirmed
  remote deletions reconcile by both server and local message identities, and
  stale responses or snapshot writes cannot restore a confirmed deleted pending
  row. Local dismissal applies only to this device and does not confirm that
  delivery stopped. Edit fills the composer only after confirmed cancellation;
  an unknown result preserves the draft. See [pending-message actions](../docs/guide/native-apps.md#android-pending-messages).
- **Conversation navigation:** the outline lists invoked/failed user messages
  from loaded history, supports loading older messages and highlights a selected
  message without following the tail.
- **Workspace:** the home menu browses an online machine's configured workspace
  roots, with breadcrumbs, hidden folders and Create here. New in same directory
  preselects the machine and worktree base path (session path fallback).
- **Session files:** long-press a file/folder in Browse, Changes or Search, or
  tap/hold the path bar, to copy its path or add it to the current message.
  Adding returns to the owning chat, preserves its draft and focuses the
  composer. Browse/Search open the complete file; Markdown defaults to Preview
  with a Source toggle, including modified files and `.markdown`/`.mdown`/`.mkd`
  extensions. Changes entries open their staged/unstaged diff.
- **Session configuration:** Codex collaboration/Fast modes, Copilot agent modes
  and capability-dependent permission/model/effort controls. Dynamic catalogs
  cover Pi (provider-qualified), OpenCode, Cursor, Grok, Copilot, Agy and Hermes;
  Claude/Gemini have presets. New dynamic controls wait for server confirmation.
  Discovery errors can be retried from the sheet.
- **Hermes:** creation and session models are searchable by provider/name/full
  ID, including custom endpoints. Discovery has refresh and error states;
  creation also accepts a manual model ID or the configured default. Settings
  changes are idle-only and wait for server confirmation. Native command
  suggestions and live steering use the same chat and durable queue controls.
- **Dictation:** provider discovery on chat entry picks the first
  `standard`-capable provider. The microphone stays hidden until one is
  available. First use requests `RECORD_AUDIO`; `MediaRecorder` records
  m4a/AAC, multipart transcription inserts text into the draft without sending.
  `DictationController` is tested with recorder/API fakes.
- **Background actions:** FCM permission Allow/Deny and inline Reply enqueue
  WorkManager jobs. Workers resolve paired hubs using stored credentials,
  without requiring a foreground `HubGraph`. Firebase-free builds skip push.

## Building

Native chat scrolling architecture and acceptance checklist:
[Native transcript scrolling](../docs/native-chat-scrolling.md).

Requires an Android SDK for `:app`/`:core:data` (set `ANDROID_HOME` or
`android/local.properties` with `sdk.dir=...`). `:core:protocol` alone needs
only a JDK.

```sh
cd android
./gradlew :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
./gradlew :app:installDebug                  # connected device
./gradlew :app:connectedDebugAndroidTest     # emulator/device instrumentation
```

Without an Android SDK you can still run the protocol suite by configuring
only the needed projects:

```sh
./gradlew --no-configuration-cache --configure-on-demand :core:protocol:test
```

CI ([`android.yml`](../.github/workflows/android.yml)) runs protocol/data/app unit
tests, assembles both the debug app and instrumentation APK, and runs lint.
API 29/33/36 emulator jobs run the general instrumentation suite followed by
`BackgroundNotificationDeliveryTest` in a separate process; reports retain both
phases. It supports manual dispatch, pushes to `main` and
`android-session-parity`, and PRs touching Android, fixtures or the workflow.

In a matching commit's Actions run, download `hapi-android-debug-<full-commit-sha>`
and extract the APK. Unit/lint results are in `android-unit-lint-reports`;
emulator results are in `android-test-reports-api-29`, `-33` and `-36`. APK
upload and emulator verification have separate jobs, so check all of them when
assessing a build. See the [verification snapshot](#verification) below.

### Protocol conformance fixtures

`:core:protocol` is the porting target for `web/src/chat/` and is verified
against golden fixtures generated from the web implementation.
The test task already passes the fixtures location as a system property:

```kotlin
// core/protocol/build.gradle.kts
tasks.test {
    systemProperty("hapi.fixtures.dir", rootDir.parentFile.resolve("shared/fixtures").absolutePath)
}
```

Fixture-driven tests read `System.getProperty("hapi.fixtures.dir")` from the
checked-in golden fixture set. CI re-runs this suite whenever `android/**`
or `shared/fixtures/**` change.

Fixtures pin protocol/state semantics, not identical web/native presentation.
When changing fixture inputs or generation, run `bun run gen:fixtures` at the
repo root and include generated changes; never hand-edit fixtures. See the
[fixture guidance](../shared/fixtures/README.md).

## Pairing

HAPI is self-hosted: the app talks to a hub **you** run. Pairing = giving the
app a hub URL plus that hub's access token; the app verifies the hub
(`GET /health`, requiring the supported protocol version exactly), exchanges
the token for a JWT
(`POST /api/auth`), stores the credentials in `EncryptedSharedPreferences`
(keyed per hub — multiple hubs can be paired, one active at a time), and
lands on the session UI. Three entry points:

1. **QR scan** — the hub prints two QR codes when started with `--relay`
   (also under web Settings → Companion pairing). The in-app scanner accepts
   both: the companion deeplink (`hapicompanion://bind?hub=…&code=…`) and the
   web direct-access URL (`…?hub=…&token=…`).
2. **Deep link** — scanning the companion QR with the system camera opens the
   app directly with a confirm screen (`hapicompanion://bind` intent filter).
3. **Manual entry** — hub URL + access token, for hubs started without
   `--relay`.

### Pairing against a development hub

```sh
# Start a hub with the built-in HTTPS relay (prints the access token + QR codes).
hapi hub --relay

# Use the printed https:// URL. For a source-tree `bun run dev` hub, put an
# HTTPS reverse proxy or tunnel in front of localhost:3006 first.
adb shell am start -a android.intent.action.VIEW \
  -d "hapicompanion://bind?hub=https%3A%2F%2Fhub.example.com&code=<accessToken>"  # optional: exercises the deep link
```

This fork accepts both HTTP and HTTPS hub URLs in manual entry, deep links,
QR codes and restored hub state, including LAN addresses. The manifest allows
cleartext traffic for HTTP hubs.
Sign-out (home → Hubs and settings → Sign out) deletes the stored credentials
for that hub and drops it from the roster.

Temporary authentication refresh failures (network/5xx) keep paired
credentials. A rejected access token or a second 401 after a successful
refresh requires re-pairing. See the [auth contract](../docs/api/client-contract/auth.md#silent-re-auth-401-handling).

## Background notifications without Firebase

In **Settings → Background notifications**, enable reception for the current
hub and grant Android notification permission. A foreground service keeps the
existing global SSE connection eligible for background reconnects, without
Google Play services or a Firebase configuration. HTTP LAN hubs are supported;
the phone must still be able to reach the hub. No hub upgrade is needed.

The persistent notification shows connection status and offers **Open app** and
**Stop receiving**. Task completion, pending approval and input-request alerts
open the originating paired hub/session. They have no inline approval or reply
actions. The open foreground conversation suppresses its own alerts; lock-screen
previews hide content. While local reception is enabled, FCM presentation is
suppressed to avoid duplicate notifications.

The persistent notification also shows the last server-data receipt time,
including SSE heartbeats (normally every 30 seconds). A connected label alone
does not prove that data is still arriving: if the timestamp stops advancing
while the app is backgrounded, check the transport/background execution before
investigating notification presentation.

The enabled preference survives app restarts, but a stopped process is not
restarted by a boot receiver or sticky service. Open the app again to resume.
Battery restrictions, Doze, force-stop and unreachable networks can interrupt
or delay reception. No permanent wake lock is held. API 34+ declares the
`specialUse` foreground-service type for this explicitly enabled ongoing
connection; the time-limited `dataSync` type is not used.

Reconnection reconciles outstanding approvals/questions and retracts resolved
alerts. Completion notifications are recovered only when the existing SSE
replay can supply them; the app does not scan old conversation history.
Deduplication is per hub, bounded to 2,048 identifiers and seven days, and stores
no message bodies. Settings and dedup records are excluded from backup/transfer.

Verification runs in GitHub Actions (API 29/33/36). Physical-device acceptance
should include LAN connection, background/lock screen, network loss/recovery,
hub switching, permission denial and reopening the app after stopping it.

## Firebase / push

**Official Firebase builds:** pair an updated hub and allow
notifications. The official Firebase client configuration is bundled in the
app. Hubs without a private `FCM_SERVICE_ACCOUNT_PATH` use the official push
relay automatically; users do not create Firebase projects or configure
service-account keys. Google Play services and FCM connectivity are needed.
The push relay also works with hubs accessed through Tailscale or other HTTPS
setups; it is independent of `hapi hub --relay`.

**Private builds:** create a Firebase project for your application ID,
download `google-services.json` into `android/app/`, and configure the hub's
`FCM_SERVICE_ACCOUNT_PATH` for that same project. Existing configured hubs
keep direct delivery under the default `HAPI_ANDROID_PUSH=auto`. Use
`relay`, `fcm`, or `off` to select explicitly. `HAPI_PUSH_RELAY_URL` overrides
the shared Android/iOS relay URL. One hub cannot mix private-project builds
and official-project builds.

**Builds without Firebase:** the Google services plugin stays conditional.
Without `app/google-services.json`, Firebase does not initialize and FCM
paths no-op; local background notifications above remain available. Ordinary
PR builds require no credentials. Official builds use
a separate mandatory configuration check (below).

**Encrypted relay:** the app registers its FCM token, install ID and random
32-byte `pushKey` with every paired hub. The ID/key are persisted together in
Keystore-encrypted preferences excluded from cloud backup and device
transfer. First upgrade replaces the old DataStore identity through the
hub's token deduplication; later token rotations reuse the ID/key. On start,
pairing, token rotation and worker retries, registrations refresh
automatically. Sign-out unregisters before wiping that hub's credentials.

Relay messages carry only `hapi_v`/`hapi_e`. AES-256-GCM decryption uses the
same golden vector as iOS; notification content is unavailable to the relay
and Google. Failed decrypts are dropped. Direct private FCM retains its
existing unwrapped data payload. Rendering, foreground-chat suppression,
Allow/Deny and Reply workers use the same decoded `PushPayload` in both paths.
`input-request` notifications instead preview the first question, remaining
question count and session name, using the HIGH-importance `input_requests`
channel. They offer no Allow/Deny or message Reply: tap to open the session and
answer in the question form.
The notification contract still does not name the sending hub: action
workers try the active hub first, then other paired hubs on session miss;
tapping opens the session against the active hub.

See [native companion contract](../docs/api/native-companion-contract.md)
for wire details and [relay deployment](../relay/README.md) for maintainer setup.

### Official APK/AAB builds

The [Android Official Build workflow](../.github/workflows/android-release.yml)
is manually dispatched on `main`.
It tests and uploads signed APK/AAB artifacts; it does not publish to Play.
Provide a new positive `version_code` and the desired `version_name`.

Repository configuration, set once by the maintainer:

| Setting | Value |
|---|---|
| Variable `ANDROID_FIREBASE_PROJECT_ID` | Project used by the deployed relay's FCM service account |
| Secret `ANDROID_GOOGLE_SERVICES_JSON` | Firebase **client** config for `run.hapi.companion` in that project |
| Secret `HAPI_UPLOAD_KEYSTORE_BASE64` | Base64-encoded release keystore |
| Secret `HAPI_UPLOAD_KEYSTORE_PASSWORD` | Keystore password |
| Secret `HAPI_UPLOAD_KEY_ALIAS` | Optional, defaults to `upload` |
| Secret `HAPI_UPLOAD_KEY_PASSWORD` | Optional, defaults to store password |

`-PhapiOfficialBuild=true -PhapiFirebaseProjectId=<project>` requires a
matching Firebase project/package and release signing configuration.
Missing or mismatched settings fail the build instead of shipping a package
without working push. `hapiVersionCode` and `hapiVersionName` override the
normal version defaults. The Firebase service-account private key belongs
only on the relay and must never enter Android build artifacts.

Roll out relay support/credentials first, then the hub, then the app. Verify
real background, lock-screen and cold-process notifications using a hub with
no Firebase settings; test Allow/Deny/Reply and an iOS push before publishing.

## Release signing

Builds do not require signing secrets. `:app:bundleRelease` produces an **unsigned** AAB unless an
upload key is configured via gradle properties (user-global
`~/.gradle/gradle.properties`), environment variables (CI secrets), or
`android/local.properties` (gitignored; same property names — the
conventional machine-local home, loaded explicitly since it is not part
of gradle's own property chain):

| gradle property | env | meaning |
|---|---|---|
| `hapiUploadKeystore` | `HAPI_UPLOAD_KEYSTORE` | keystore path (`~` ok) |
| `hapiUploadKeystorePassword` | `HAPI_UPLOAD_KEYSTORE_PASSWORD` | store password |
| `hapiUploadKeyAlias` | `HAPI_UPLOAD_KEY_ALIAS` | default `upload` |
| `hapiUploadKeyPassword` | `HAPI_UPLOAD_KEY_PASSWORD` | default: store password |

This is an **upload key** for Play App Signing (Google holds the actual
distribution key, so a lost upload key is resettable in Play Console).
Generate one with:

```bash
keytool -genkeypair -v -keystore ~/.hapi/upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10950
```

Keystores never live in the repo (`*.keystore` / `*.jks` are gitignored).

## Modules

| Module | Type | Responsibility |
|---|---|---|
| `:core:protocol` | **pure Kotlin/JVM** (no Android) | Hub wire types, chat pipeline, message pagination, versioned patches, agent/mode catalogs, git parsers, pairing links, and golden-fixture conformance tests. |
| `:core:data` | Android library | OkHttp API/SSE transport, per-hub authentication, secure credentials, StateFlow stores and disk snapshots, encrypted push registration/decoding, and background notification actions. |
| `:app` | Android application | Compose screens for pairing, sessions/chat, approvals, new sessions, files, Scratchlist, dictation, usage/storage, and settings; navigation, localization, FCM service, and WorkManager wiring. |

Dependency direction: `:app` → `:core:data` → `:core:protocol`.

## Internationalization

The app ships English (default) and Simplified Chinese
(`app/src/main/res/values-zh-rCN/strings.xml`). App UI strings
live in resources; both files carry the **same key set** (lint
`MissingTranslation` is the gate).

**Adding a string**

1. Add it to `app/src/main/res/values/strings.xml` with a feature-prefixed
   key matching the existing convention (`chat_`, `sessions_`, `files_`,
   `scratchlist_`, `pairing_`, `settings_`, `new_session_`, `notif_`,
   `tool_` for tool-card titles). Dynamic values use positional format args
   (`%1$s`, `%2$d`); count-dependent copy uses explicit `_one`/`_many` keys
   (the deliberate house style — no `<plurals>`).
2. Add the zh-CN twin to `values-zh-rCN/strings.xml`. **Terminology source of
   truth is the web corpus** `web/src/lib/locales/zh-CN.ts` — reuse its
   product terms (会话 session, 机器 machine, 权限模式 permission mode,
   工作树 worktree, 草稿夹 scratchlist, 语音输入 dictation, 用量 usage,
   智能体/代理 agent). Technical identifiers (model ids, flavor names like
   Claude/Codex, permission-mode catalog labels, CLI flags) stay
   untranslated, matching the web's choices.
3. Reference it: composables via `stringResource(R.string...)`. ViewModels
   stay string-free — transient notices are **semantic sealed types**
   (`ChatNotice`, `ScratchlistNotice`, `PairingError`, `DictationErrorKind`)
   resolved at the UI layer; where a ViewModel genuinely composes display
   text it takes a small Strings seam (`FilesStrings`, `FileViewerStrings`,
   `NewSessionStrings`) whose defaults are the English values (JVM tests
   construct without arguments) and whose production instance is
   resource-resolved in the Navigation holders. Server-provided error text
   passes through verbatim.

**Language switching**

`Settings → App language` offers Follow system (default) / English /
简体中文. The choice persists in `LanguagePrefs` (DataStore) and applies
immediately via `AppCompatDelegate.setApplicationLocales`:

- `MainActivity` extends `AppCompatActivity` (theme parent
  `Theme.AppCompat.DayNight.NoActionBar`) so per-app locales work back to
  API 26; on API 33+ the framework `LocaleManager` takes over (the app also
  declares `android:localeConfig` for the system App-languages screen).
- The manifest opts into appcompat's `autoStoreLocales`
  (`AppLocalesMetadataHolderService` meta-data), which re-applies the stored
  choice synchronously on cold start.
- Surfaces that resolve strings from the **application** context — FCM
  notifications, WorkManager result updates, notification-action receivers —
  wrap their context with `localizedForAppLanguage(AppGraph.appLanguage)`
  (`di/LocaleContexts.kt`), since per-app locales only retarget activity
  contexts below API 33.

Out of scope on purpose: `:core:protocol` presentation strings
(`getEventPresentation`, tool-group activity titles) stay English — the web
does not translate them either, and terminology parity with the web wins.

## Chat file and media cards

Chat media cards use the existing authenticated generated-media endpoint, including
HTTP LAN hubs. Images open a full-screen viewer with pinch zoom, pan, zoom/reset
buttons, and previous/next navigation across images in the loaded conversation.
User image attachments use the same viewer; ordinary attachment chips show filename
and size. SVG and animated image decoders are enabled on the hub image loader.

Audio, video and ordinary files download only after a tap. Transfers stream to a
private temporary file rather than buffering the full response in memory, and can
be cancelled or retried. Audio/video have native playback controls; videos also
support full screen. Playback pauses on background and releases when its card
leaves composition. Unsupported codecs can still be saved and opened in another app.
The Save action uses Android's document picker without broad storage permission.
Temporary files are removed on card disposal; abandoned files expire after 24 hours
and are cleaned when another download starts. No changes to the Hub API are required.

## Tool previews

Ordinary chat tools stay compact summaries. Tap a tool or tool group to open a native
Navigation Compose page; Back returns one level, Close returns to the chat.
Groups start at their latest tool, retain their position when returning from
details, and never follow streaming updates automatically. The **Latest tool**
toolbar action scrolls explicitly. Agent processes have their own page with
lazy child rows. Approvals remain in the conversation or a live process page;
ordinary tool detail pages are read-only.

Plan proposals (`ExitPlanMode` / `exit_plan_mode`) start fully expanded in the
conversation, rendering the complete `input.plan` Markdown before approval
controls. Tapping the header folds the card. Plan documents are prewarmed in the
chat Markdown cache and do not use the ordinary tool-output paging budget; raw
input/result remains under Source.
Shared Codex proposals also show **Implement plan** and **Continue planning**
when the active session's `agentState.codexPlanProposalId` matches the tool-call
id. Implementation uses the dedicated plan endpoint, not permission approval;
continue hides that proposal’s action menu locally and focuses the composer,
preserving its draft and plan mode without sending a message. The plan document
remains readable, and a new proposal gets a fresh menu. The menu stays visible
when the document is folded; pending/error state survives row recycling.
Withdrawn, historical and child proposals remain read-only (an outstanding
operation/error can still be shown).

Details recognize namespaced command/script/patch calls, unwrap common
nested result envelopes, and keep command exit/status metadata visible. File
reads use source-language highlighting; web/agent prose uses Markdown. **Source**
reveals the original input/result, including fields omitted from the preview.
Mixed text/media results stay JSON instead of dropping non-text blocks.

Question details show recorded selections, custom answers and notes with
Markdown questions/options. Codex choice questions with `isOther: true` add
**None of the above** and focus optional notes when selected; empty notes are
valid. Translations never change the submitted `None of the above` wire value.
Pi/MCP forms without `isOther` keep their existing choices. Recorded other
answers and notes are also shown in question details.
`request_user_input` also restores answers from
historical results; live permission answers take precedence. Answered cards
avoid duplicate results, but retain errors and the full input/result/answers
under **Source**. Pending questions are answered in the conversation.

Tool inputs/outputs display one part at a time, up to 20,000 Unicode graphemes
or 400 source lines. Previous/Next replace the mounted part; visited parts do
not accumulate. Large diffs/Markdown use paged source. JSON formatting and
output preparation run off the UI thread. File mutation details also offer
**View current file**, distinct from the recorded tool input/result.

Inspectors share the conversation's pipeline and SSE subscription. Opening one
freezes tail following, cancels hidden history loading and recording, and hides
the keyboard. Returning retains the transcript anchor. Trimmed selections remain
readable as labeled snapshots; an epoch reset closes obsolete inspectors.

## Long messages and reading layout

User prompts remain inline through 8,000 graphemes and 120 source lines. Larger
prompts show a 2,000-grapheme / 24-line preview and **View full message** opens a
reader with one 4,000-grapheme / 80-line part mounted. Pagination preserves
whitespace, CRLF, emoji and combining sequences exactly; character counts refer
to Unicode graphemes, not UTF-16 offsets.

**Copy full content** uses the clipboard up to 64 Ki UTF-16 code units. Larger
content, or a failed clipboard operation, offers UTF-8 file export through
FileProvider and Android's sharesheet; Binder receives a URI, not the text.
Exports older than 24 hours are cleaned on the next export.

Body/composer/user text uses 16sp/24sp, code/diff/terminal 14sp/20sp, captions
12sp/16sp. Content and composer share a centered 720dp reading column with
16dp minimum side margins. Bubble widths use actual container constraints,
including split-screen; Android font scaling remains enabled.

## Connection status and home filters

The chat subtitle reserves its height. **Reconnecting · Tap to retry** appears
after four continuous foreground seconds of outage; retry/backoff transitions
do not restart that grace period. Transport state is separate from message
events. Default-network/interface/route changes wake reconnect immediately,
preserving replay cursors; background retries defer until foreground. A local
hub route does not need Android's internet-validation capability.

Home centers the Sessions title between a **Hubs and settings** icon and a
**Filters** icon, keeping the new-session FAB. The hub menu is the only entry
for switching/adding hubs, app settings and sign-out; the active hub is checked.
The filter icon marks an applied filter and opens a Material 3 single-selection
sheet. Choices come from all sessions, including historical
machines; names/IDs determine ordering, never counts. Duplicate names include
IDs; unnamed and unknown machines are labeled. The applied filter has a Clear
action, is transient per home/hub, and is cleared when no longer valid.
The home holder follows the active connection instance, releasing the previous
store and filter even when switching back to a previously used hub URL.

Pairing and Settings both link to the [privacy policy](https://hapi.run/docs/privacy).
These controls and notices ship in English and Simplified Chinese.

## Verification

### CI snapshot (2026-10-08)

Verified code commit: [`4e2422cd`](https://github.com/drch90/hapi/commit/4e2422cdd72f8c1c78dd38450a6a0979e9e4be89),
including context usage and unknown-delivery dismissal/deletion reconciliation.
[Android run](https://github.com/drch90/hapi/actions/runs/37730858444):

| Check | Result |
|---|---|
| Protocol/data/app unit tests | 820 passed: protocol 283, data 264, app 273. |
| Debug APK, instrumentation APK and lint | Passed; debug APK uploaded for the commit above. |
| API 29 / Android 10 | General and background-notification instrumentation passed. |
| API 33 / Android 13 | General and background-notification instrumentation passed. |
| API 36 / Android 16 | General suite: 46 passed, 1 failed, 1 skipped. Background phase did not run after the failure. |

The API 36 failure was
`LocalNotificationsTest.settingsStartAndStopForegroundReceptionWithoutFirebase`:
waiting for missing-credentials reception to reach `PairingRequired` timed out
with `enabled=true, status=Stopped`. This run was **not all green**. The skipped
test was the opt-in frame profiler. The separate
[Test workflow](https://github.com/drch90/hapi/actions/runs/37730858429) passed all
three jobs (test, integration and Windows Codex MCP).

New regression coverage checks dismissal persistence, remote cancellation by
both message identities, stale REST/SSE responses, serialized snapshot writes,
requeue/delivery acknowledgements and preserving drafts during unknown edits.
Context-usage coverage includes parent/child usage selection, reported/catalog
limits, fallback budgets, English/Chinese and large font scaling.

### Earlier manual and emulator checks (2026-09-12)

These observations apply to the earlier builds tested on that date.

Protocol/data/app JVM suites: 722 tests passed. Debug APK, instrumentation APK
and lint passed. Pixel 6 (Android 17/API 37): installed and visually checked the
home toolbar, hub/settings menu, applying/clearing filters, English/Chinese
switching and code-copy feedback. Code headers keep an 18dp action icon inside
a 48dp touch target, at the trailing edge even with short language labels.

API 36 ARM64 emulator (macOS Hypervisor.Framework): 8 targeted instrumentation
tests passed, including 5 new toolbar/code-layout regressions (320dp width,
English/Chinese, 2× font scaling), exact clipboard/file export and question
details. The full 30-test run was **not all green**: 3 transcript group-anchor
checks and the tool-browser initial-position check also fail with the pre-fix
APK. One question-details timeout passed on targeted rerun; the opt-in frame
probe was skipped. API 37 instrumentation is blocked by the current Espresso
dependency calling the removed `InputManager.getInstance()` method.

Earlier API 29 checks passed 19 chat/reader regressions. No 60/120 Hz device
frame-time, memory, or predictive-back measurements are claimed by these checks.
