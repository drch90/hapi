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
| Session-attached jobs (outliving work) | [session jobs guide](docs/guide/session-jobs.md), `cli/src/commands/job.ts` |
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

## Session-attached jobs (outliving work)

When an agent starts process-shaped work that will keep running after the agent goes idle (`nohup`, batch imports, long scripts, external daemons), attach it so the session list stays truthful while `active: false`. This is **not** thinking progress / todos / in-agent background tools.

Agent contract (idle agents cannot heartbeat — bare set + nohup freezes the bar):

1. **Required for process-shaped work:** Shell `hapi job run <session-id> <key> --label … --progress unknown|fraction|until … -- <cmd>` (auto-heartbeat + exit status; `--progress` required). Use `"$HAPI_SESSION_ID"` only when it matches the operator chat row (`/sessions/<id>` in the web URL).
2. MCP `session_job` **refuses `action=set`**. Use it only for `update` / `clear` / `list` on a job the supervisor already created.
3. Manual CLI `set` only with a self-heartbeating wrapper (`update` ≥~10m); never MCP set + nohup.
4. Prefer honest `--remaining`+`--total` or `--done`/`--total` for a determinate fill; omit counts if unknown — list shows a subtle indeterminate striped bar (no %). Never invent a percent.
5. Elapsed wall clock is always shown from `startedAt` (not an ETA).

Full guide: [docs/guide/session-jobs.md](docs/guide/session-jobs.md). CLI: `hapi job --help`.

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
- Reuse passing evidence only when the checked code, dependencies, workflow and relevant environment are unchanged. Do not use CI-skip markers or weaker checks to claim success. The same gate applies to automated fix-and-push loops below.
- Report the evidence actually obtained. Passing preflight reduces avoidable failures; it does not guarantee GitHub runner availability or network reliability.

## PR follow-through: review wait + auto-fix loop (agents)

Opening or updating a PR does **not** end the task. Enter a bounded review-wait phase and watch, for the current HEAD: GitHub Checks, PR reviews, plain comments, and inline review comments.

- **Entry condition.** This loop runs only inside a task that already authorizes PR follow-through (the user asked to open/update the PR and expects it carried to a merge-ready or explicitly blocked state). It does not override the authorization boundaries and CI-wait exemptions in *Task boundaries* and *Verification and completion*: waiting here is required, not the "do not wait on CI" case, because the deliverable is the reviewed PR itself; anything still needing fresh authorization (force-push, new dependencies, production data, ...) goes to "Stop and ask first".

- **One window per HEAD.** Each wait round targets the current HEAD: max 30 minutes, poll every 60s. Prefer a quiet Shell/`gh` polling loop that prints only on state change, new feedback, failure, or timeout — do not re-run full model reasoning every minute, and do not repeat identical output. After an auto-fix is pushed to the same PR branch, restart a fresh wait round from the new HEAD; never cram every round of a task into one 30-minute window.
- **Coverage.** `gh pr checks --watch` covers checks only; it does not replace reviews/comments polling. Also watch new reviews, issue comments, and review comments. Baseline against the current PR, the current HEAD commit, and the feedback already present when the round started: the baseline records which items were already handled or explicitly rejected (so stale comments are not reprocessed), but unresolved feedback present at round start stays in scope — it is carried forward, not silently dropped.
- **Auto-fix.** For clear, local feedback that does not change the agreed requirements: verify the point, implement the minimal fix, run scope-matched tests, inspect the diff, commit, and push to the same PR branch, then wait for the next round on the new HEAD. No need to ask the user for each such fix.
- **Loop bound.** At most 100 consecutive auto-fix rounds (one round = one fix-and-push for a tip review point). Stop and report when the cap is hit, when the same blocker survives 100 materially different attempts, or when a wait window ends with no checks/review results — report the current HEAD, feedback handled, items still pending or failing, and the suggested next step. A single-round timeout ends only that wait; never keep editing code with no new feedback just to reach 100 rounds.
- **Stop and ask first.** Do not auto-edit or push when feedback would change product behavior or the original requirements; when several mutually exclusive options would materially change the outcome; when the PR scope must grow; when dependencies, migrations, or architecture changes are involved; when security, credentials, or production are involved; when force-push, history rewrite, or closing/replacing the PR is needed; or when feedback conflicts with user instructions or the PR's stated goal.
- **Bots can be wrong.** Verify against the code, tests, and original requirements before fixing. Do not change code just to silence the bot on a point that does not hold — provide evidence and, when useful, a concise reply.
- **No context burn.** Waiting must not consume context with high-frequency output. Sleep/blocking waits need no model reasoning; hand the model only the minimum necessary information, and only after a state change. If the machine sleeps, the network drops, the GitHub API rate-limits, auth expires, or a tool times out, say so honestly — never claim the wait finished or the checks passed.
- **Contributor-side done.** At minimum: required checks for the current HEAD pass; the latest actionable review feedback is handled or explicitly rejected with reasons; and no verification that should have been re-run after the last fix was skipped. Do not merge into upstream `main` by default (contributors usually lack permission) — report readiness and let the maintainer merge. Merge only when the user explicitly asks and the current account really has write access to the target repo.
