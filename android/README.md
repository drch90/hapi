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

- **Session actions:** pin/archive plus Rename, Delete and explicit Reopen
  from the list/chat actions. Delete requires an inactive session. Resume or
  Reopen can return another session ID: seed its window, move the draft and
  replace navigation with the returned ID.
- **Composer:** optimistic send, queue/steer where supported, drafts and
  attachments uploaded on selection. Slash suggestions combine session
  metadata and the slash-command RPC; the skills `$` picker has no UI.
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

The commands below are for CI or a dedicated Android build machine. On the HAPI
service host, do not run Android unit tests, including the SDK-free protocol
suite, or other Gradle compilation/lint, APK assembly or emulator checks. Do not
install or recreate a local Android SDK/JDK/Gradle test environment. Use static
source/diff inspection on that host; see the
[service-host verification policy](../AGENTS.md#verification-and-completion).

Requires an Android SDK for `:app`/`:core:data` (set `ANDROID_HOME` or
`android/local.properties` with `sdk.dir=...`). `:core:protocol` alone needs
only a JDK.

```sh
cd android
./gradlew :app:compileDebugKotlin :app:compileDebugUnitTestKotlin :app:compileDebugAndroidTestKotlin --continue --console=plain
./gradlew :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug --continue --console=plain
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
./gradlew :app:installDebug                  # connected device
./gradlew :app:connectedDebugAndroidTest     # emulator/device instrumentation
```

On a dedicated build machine without an Android SDK, run the protocol suite by
configuring only the needed projects:

```sh
./gradlew --no-configuration-cache --configure-on-demand :core:protocol:test
```

This fork retains only **Android APK**
([`android.yml`](../.github/workflows/android.yml)), using Ubuntu 24.04 and JDK 21.
Pushes to `android-session-parity` build only when Android source/build files
or shared conformance fixtures change. Documentation-only and non-native
pushes do not start Android builds. Workflow/signing-helper configuration
edits run a lightweight scope check and skip Gradle when those inputs are
unchanged. Manual dispatch explicitly requests a rebuild. Superseded runs
are cancelled; there are no PR, scheduled, release, bot or other-platform jobs.

The build job validates the fixed signing key, compiles the app, unit tests
and instrumentation tests, then runs protocol/data/app unit tests and lint.
Only successful preflight proceeds to debug APK assembly. Before upload,
the workflow checks the APK's signature, application ID and version code.
There is no emulator job or instrumentation APK artifact; successful CI does
not verify device behavior.

On the HAPI service host, perform static source/diff checks and use one remote
preflight for the reviewed change set; do not run Gradle locally. Use the same
remote fallback on other machines without enough disk or a native toolchain.
Collect failures and fix them together before the next run. Avoid dispatching
another build when a push has already triggered one.

To start a build manually, open **Actions → Android APK → Run workflow** in
GitHub and leave the workflow branch as `main`. Manual runs always build the
current `android-session-parity` source, pinning the checkout SHA across jobs.
Keep the workflow on both branches so the default branch exposes the button.

Download `hapi-android-debug-<source-commit-sha>` from a successful run and
extract `app-debug.apk`. The artifact also contains `signing.json` with the
source SHA, package, version code, APK hash and public certificate hash.
Unit/lint results are in `android-unit-lint-reports`; artifacts are kept for
seven days.

### Fixed APK signing

Set the repository Actions secret **`HAPI_ANDROID_DEBUG_KEYSTORE_BASE64`** to
the base64 encoding of the fixed PKCS12 debug keystore. It must use the standard
alias `androiddebugkey` and store/key password `android`. Keep the same secret
for subsequent builds. The expected public certificate SHA-256 is committed in
[`android-debug-certificate.sha256`](../.github/android-debug-certificate.sha256);
the private keystore is never committed, cached or uploaded as an artifact.
CI restores the key into the runner's temporary directory and passes its path
as `HAPI_ANDROID_DEBUG_KEYSTORE`; Gradle explicitly uses that PKCS12 file for
debug signing. The lightweight scope job also runs Python signing-helper
checks, which need no Android SDK or Gradle. The build job compiles
`tools/HapiApkVerifier.java` against the SDK's bundled `apksigner.jar` before
APK assembly. It validates the APK signature and certificate through the
Android signing library API, without parsing the CLI's display text.

On the machine holding that key, encode it with `base64 -w0 /path/to/debug.keystore`
and paste the value into **Settings → Secrets and variables → Actions → New
repository secret**. Do not paste it into issues, logs or chat. Missing keys,
invalid aliases and certificate mismatches fail before Gradle starts.

The APK keeps `run.hapi.companion` and uses the existing workflow's increasing
`github.run_number` as `versionCode`. From the first APK built with this fixed
key onward, newer APKs can update it in place and retain app data. Older APKs
signed by an ephemeral CI key may require a one-time reinstall; their signatures
are not recovered. Play-installed builds use a different signing identity.

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

The APK workflow compiles instrumentation sources but does not run a device or emulator.
Physical-device acceptance should include LAN connection, background/lock screen, network loss/recovery,
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

The [upstream Android Official Build workflow](https://github.com/tiann/hapi/blob/main/.github/workflows/android-release.yml)
is not retained in this fork. The fork's Android APK workflow produces debug
APKs and does not inject Firebase configuration, publish releases or upload to
Google Play. Official APK/AAB builds require a separate dedicated build machine
and the [release signing](#release-signing) configuration below.

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

### Validation status (2026-09-12)

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
