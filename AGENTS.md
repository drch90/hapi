# AGENTS.md

HAPI is a local-first platform for running coding agents with remote control via web/phone.
CLI wraps agents → hub (Socket.IO) → web/native clients (REST + SSE).

## Task boundaries

- Complete the requested deliverable and relevant verification; do not stop at the first implementation unless the user requested a review checkpoint.
- Fix causes within the task's scope. Report unrelated problems rather than turning them into refactors or additional features.
- Make reasonable, reversible choices and continue. Ask when missing information materially affects correctness, an action needs additional authorization, or progress requires overwriting someone else's changes. Continue unaffected work.
- Preserve existing user/agent changes. Editing or generating files does not imply permission to commit, push, or release.
- Keep communication concise and clear; report results, checks performed, and remaining limitations.

## Find context when needed

Start with the task's files; read only relevant sections of these references, not a fixed sequence of READMEs.

| Task area | Entry points |
|-----------|--------------|
| Product, setup, supported agents | [README.md](README.md), [agent guide](docs/guide/agents.md) |
| Agent wrappers, CLI commands, runner | [cli/README.md](cli/README.md); for bootstrap/handoff changes, [session lifecycle invariants](cli/README.md#session-lifecycle-invariants) |
| Hub APIs, auth, sync, notifications | [hub/README.md](hub/README.md) |
| Web routes, components, data fetching | [web/README.md](web/README.md); for optional feature discovery, [FUE](web/README.md#first-user-experience-fue) |
| Shared wire types and validation | `shared/src/types.ts`, `schemas.ts`, `socket.ts`, `modes.ts` |
| Native API contract, chat conformance | [client contract](docs/api/client-contract/index.md), [iOS](ios/README.md), [Android](android/README.md) |
| Encrypted native push relay | [relay/README.md](relay/README.md) |
| User docs / marketing site | `docs/` (VitePress) / `website/` |

## Repository conventions

- Bun workspaces: `cli`, `shared`, `hub`, `web`, `website`, `docs`, `relay`. Run workspace scripts from the root; package-scoped commands may use `bun run --cwd <package> ...` or that package's directory. iOS and Android use separate toolchains.
- TypeScript strict; keep code typed. Prefer 4-space indentation. `@/*` resolves to a package's `src/*`.
- Shared protocol is `@hapi/protocol`; runtime schemas live in `shared/src/schemas.ts` (Zod).
- No backward compatibility required for formats changed by the task; do not add compatibility layers or change unrelated formats.

## Cross-component invariants

- CLI↔hub uses Socket.IO `/cli` with the CLI access token. Web terminals use `/terminal` with a client JWT; ordinary web/native updates use REST + SSE. Preserve namespace isolation (`CLI_API_TOKEN:<namespace>`).
- Metadata/state updates are versioned; preserve stale-update rejection. Permission controls use per-flavor catalogs in `shared/src/modes.ts`, further constrained by session capabilities.
- `shared/fixtures/**` is generated from the web chat pipeline, the source of truth for native conformance. Never hand-edit fixtures. For changes to `web/src/chat/**`, `web/src/lib/{message-window-store,sessionPatch,messages}.ts`, `shared/src/**` or `web/scripts/**` that affect fixture inputs/generation, run `bun run gen:fixtures` and include any generated changes. See the [fixture guidance](shared/fixtures/README.md). This fork has no standalone drift workflow; verify generation locally, and use the Android workflow for native conformance on fixture changes.

## Verification and completion

Choose checks by the change's impact, not by the number of workflow steps:

| Change | Verification |
|--------|--------------|
| Documentation only | Check edited content, local links, and diff; no code test suite. |
| Package-local code | Relevant tests and the package's typecheck where available; add regression coverage when needed. |
| Shared contracts, dependencies, broad cross-package behavior | `bun typecheck && bun run test`, plus affected integration/conformance checks. |
| Native code | Follow the iOS/Android README; Android verification must obey the service-host restriction below. |

- **Android on this service host:** Do not run Android unit tests locally, including the SDK-free JVM `:core:protocol:test`, `:core:data:testDebugUnitTest`, `:app:testDebugUnitTest`, filtered tests, or aggregate tasks that invoke them. This applies to upstream merges, shared-contract/fixture changes, and requests to run all repository tests.
- Do not install or recreate an Android SDK/JDK/Gradle test environment on this host, even if a cached toolchain was previously available. Do not run local Android Gradle compilation, lint, APK assembly, or emulators either. Use static source/diff inspection here and CI or an explicitly designated build machine for Android verification. Only a subsequent explicit user request permitting local Android execution overrides this restriction.

- Root scripts: `bun run test:<package>` for `cli`, `hub`, `web`, `shared`, `relay`; `bun run typecheck:<package>` for `cli`, `hub`, `web`, `relay`. Shared types are checked through consumers. CLI/web tests use Vitest; hub/shared/relay use Bun test. Use file filters for focused runs.
- Within existing permissions, run and retry relevant local checks without asking at each step. Fix failures caused by the task; report unrelated failures. If tools or permissions are unavailable, complete other work and state what remains unverified; do not bootstrap native toolchains or wait on CI unless the task requires it.
- Reuse passing checks when code, dependencies, and environment are unchanged; commit/push/PR transitions alone do not require reruns. Run repository-wide checks when explicitly requested as well.
- Review this task's changes for correctness, security, and regressions. For local work, inspect unstaged/staged diffs (`git diff`, `git diff --cached`) and new files; for a branch/PR review, use the actual target branch's merge-base diff. Local self-review does not require a GitHub event, remote review, or posting comments.

## Actions preflight before pushing

- This fork retains only [.github/workflows/android.yml](.github/workflows/android.yml) (Android APK). Do not restore upstream workflows when merging upstream. Keep the workflow on both `main` (manual-dispatch discovery) and `android-session-parity` (app source); manual builds always check out `android-session-parity`. There are no scheduled, PR, release, bot, JS/TS or iOS workflows.
- Keep `HAPI_ANDROID_DEBUG_KEYSTORE_BASE64` stable and private. The workflow verifies the committed public certificate fingerprint before Gradle and the APK signature before upload. Do not generate fallback signing keys, cache/upload keystores, or reset the workflow's increasing version-code sequence. See [fixed APK signing](android/README.md#fixed-apk-signing).
- Before pushing, inspect the proposed changes against the destination branch and the branch/path filters in `.github/workflows/` to identify every workflow and build job the push will trigger. Aim for the first Actions run to pass; do not use pushes as build experiments.
- Automatic Android builds require changes to Android source, build configuration or test inputs (including shared fixtures). Documentation and non-native changes must not launch Gradle, APK assembly or emulators. Workflow-only edits may run the lightweight scope check to cancel obsolete runs; explicit manual dispatch may request a rebuild.
- Complete the locally available preflight checks and resolve known source errors before pushing. Inspect the full change, including tests and fixtures; a clean diff or an import-only fix is not proof that compilation will pass.
- Android preflight must run remotely, never on this service host. One remote preflight is allowed per reviewed change set; the same fallback applies when other native checks are unavailable locally. For Android, it must compile the app, unit tests and instrumentation tests, then run protocol/data/app tests and lint using the repository's toolchain and lockfiles. State which checks remain remote; do not install a native toolchain on this service host to duplicate CI.
- Gate APK assembly/upload on successful preflight. The retained workflow has no emulator jobs; instrumentation sources still compile, but device behavior is unverified by this workflow. Only add emulator execution when explicitly requested, using Android 16 (API 36) unless the user specifies another version. Cancel superseded runs and avoid unrelated package suites for native-only pushes. Keep required compilation/unit/lint coverage for successful builds; reducing waste must not hide failing tests.
- A failed preflight blocks downstream work. Inspect the available logs, group the necessary fixes and repeat available local checks before another run. Never push empty/touch commits or dispatch the same HEAD repeatedly to try to make deterministic errors disappear. Do not duplicate a build already triggered by a push; retry only failed jobs for a confirmed transient infrastructure fault when possible.
- Reuse passing evidence only when the checked code, dependencies, workflow and relevant environment are unchanged. Do not use CI-skip markers or weaker checks to claim success.
- Report the evidence actually obtained. Passing preflight reduces avoidable failures; it does not guarantee GitHub runner availability or network reliability.
