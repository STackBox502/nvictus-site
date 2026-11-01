# Jarvis Codex verification report

Date: November 1, 2026. Windows 10.0.26300, x64. Initial default Node 24.14.0/npm 11.9.0; final explicit-path verifier Node 26.13.0; Electron 45.2.1 contains Node 24.22.1/Chromium 156.0.8078.75. No real API credentials, microphone, speakers, camera or private screens were used in automated checks.

## Automated evidence

Latest live check, November 1: user approved a single short TTS request. Current desktop key `fb1b` passes read-only user, subscription, models and voice-catalog checks; selected voice exists. The actual TTS endpoint returned HTTP 401 with invoice/payment indicators while subscription status was `past_due`. This is a confirmed failed live request, not a successful playback baseline. No audio was generated. See `test-results/elevenlabs-live-test.json`. Earlier voice-ID and key-permission findings are historical and were resolved by the user's current configuration.

Version 0.1.1 clipboard fix: added a native Edit menu and a text context menu for editable controls and selected text. Chromium's edit flags preserve password-field copy restrictions; Paste remains available. No clipboard IPC or background clipboard reader was added. Typecheck/build, lint and all 36 existing tests pass. The 9 clipboard checks in `test-results/clipboard-source.json` cover keyboard/native editing in all three masked key inputs, voice ID, memory and chat, plus a real Windows right-click menu click that pasted dummy text. No fixture keys were saved and no provider calls or microphone capture were performed. The first clipboard test failed to restore its temporary clipboard backup; the harness now materializes new ClipboardItem objects before writing and restores them in finally. The user was told to copy the key again.

The native menu test uses the development fixture profile; it does not run against the user's credential store. Windows ignored an attempted APPDATA-only override for a separate packaged test, so that test was abandoned. Package auditing verifies that the release contains the same tested main bundle. Installation verification is recorded separately in `test-results/installed-0.1.1.json`. The original 0.1.0 UI evidence below remains a prior baseline.

| Check | Result / evidence |
|---|---|
| TypeScript | PASS, `npm run typecheck`; also required by production build |
| ESLint | PASS, `npm run lint` |
| Unit/transport/controller fixtures | PASS — 36/36 tests; output `test-results/unit-tests.txt` |
| Windows Electron UI fixtures | PASS — 18/18 checks, `test-results/ui-smoke.json` |
| Packaged application launch | PASS — final packaged executable launches; `test-results/packaged-smoke.json` |
| Package contents/checksums | PASS — 12 bundled archive entries; unchanged master and matching main bundle; `test-results/package-audit.json`, `release/SHA256SUMS.txt` |
| Production dependency audit | Zero reported vulnerabilities at audit time; `test-results/production-dependency-audit.json` |
| Optional wake helper | PASS on synthetic silence only; `test-results/wake-fixture.json` |

The unit suite covers streaming sentence assembly and final flush, abbreviations/decimals, Markdown cleanup, input resampling at 48/44.1 kHz, exact PCM packets, stereo averaging, duplicate turns, generation invalidation, bounded context and interrupted replies, strict IPC/settings, error redaction, ordered output/ack cancellation, model-specific request adaptation, malformed/incomplete provider behavior, PCM network boundary reconstruction, memory CRUD/concurrent writes, history opt-in/deletion, vault failure-closed/session-only behavior, session limits, preview/network separation, local wake idle boundary, and early push-to-talk release before input is ready.

Ten consecutive **controller speech fixtures** complete with the final sentence confirmed by a fake playback clock. This is not ten microphone/ElevenLabs live conversations. Provider transport fixtures return deterministic API-shaped events; they do not establish account access or current server compatibility.

Windows UI fixtures verify sandbox/no Node, mic off at launch, rejection of unknown IPC, camera denial, idle mic denial, real Windows safeStorage with a dummy secret, two synchronized windows, visible original character, actual PNG and WebP import/copy, page layout, memory save, local fake-microphone start/Stop, preview controls, transparent document backgrounds, restricted overlay mutations and off-screen position recovery. The microphone comes from Chromium's fake-device flag, not hardware. The safeStorage test uses `fixture-not-a-real-api-key`, never a real account credential.

## Visual inspection

Rendered screenshots were inspected: `conversation.png`, `character.png`, `overlay.png`, and final packaged screenshot when available. The original 1254 × 1254 alpha PNG is used. Inspection caught and corrected a CSS class collision hiding the character and an opaque root background in the overlay. Corner alpha was checked as 0. WebP initially failed Electron's native decoder; the importer now uses a bounded, transaction-scoped sandbox decode followed by main-process PNG validation and copying. Actual import tests cover both formats.

No claims of mouth lip-sync, live microphone-reactive animation or speaker synchronization are based on screenshots. Physical Windows click-through/drag/full-screen behavior and multi-monitor DPI changes remain separate checks below.

## Build findings and resolved failures

- Sandboxed npm DNS failed; approved network execution installed dependencies.
- The inherited `ELECTRON_RUN_AS_NODE` flag initially prevented GUI launch. Source launch/test wrappers remove it for the Electron child.
- A network-deny rule initially blocked internal `net.fetch(file:)`. Local protocol resources now use bounded path-validated file reads and typed Responses, with arbitrary renderer networking still denied.
- UI test window selection had a chat/overlay race; tests now choose the main URL explicitly.
- Navigation icon glyphs polluted accessible names; decorative icons are now hidden from accessibility naming.
- Early push-to-talk release now cancels pending permission/capture rather than leaving an unintended listening session.
- A silent follow-up window returns to local armed mode instead of repeatedly opening cloud windows.
- Cold wake-runtime initialization needed up to roughly 26 seconds including first import and four seconds of synthetic processing. Startup is bounded at 45 seconds. This is not a live detection-latency benchmark.

## Limits and unverified live checks

| Remaining check | Exact next action |
|---|---|
| Claude text + voice | Enter Anthropic and ElevenLabs credentials locally, load catalog, select model/voice, send one typed and one spoken question |
| OpenAI text + voice | Configure OpenAI independently, acknowledge context transfer, complete its own turn |
| Voice model/voice ID pairing and sound | Run short paid preview using selected account voice/model; confirm output device, voice settings and final sentence |
| Ten real voice turns | Run one app only, ten short questions, check transcripts, ordered speech, tail delivery and no repeated turns |
| Stop and PTT during sound | Interrupt speech while another app has focus; verify physical silence and no stale output; test very early key release |
| Speaker/headphone feedback | Test separately; half-duplex remains default. Automatic spoken barge-in is not implemented/enabled |
| Wake phrase | Install optional runtime for packaged app; test “Hey Jarvis” with pause and same-breath command, false activations, refractory interval and stop listening |
| Follow-up listening | Set a short nonzero follow-up, verify silent expiry returns to local-only mode and no idle cloud audio |
| Permission/device/network failures | Test denial, silent mic, unplug/Bluetooth change, invalid/expired key, exhausted credits, disconnect mid-stream; verify explicit retry and typed-chat availability |
| Sleep/lock/resume/quit | Inspect real device indicators/handles and helper exit; microphone must remain off after resume |
| Output routing | Test target speakers/headphones and Windows per-app device selection |
| Native overlay interactions | Confirm click-through around alpha pixels, clickable controls, handle dragging, focus retention, tray recovery, monitor detach/DPI and exclusive full-screen behavior |
| Clean user install | Test portable wrapper/NSIS on a normal account or clean machine; signed trust is not provided |
| Live end-to-end latency | Collect speech-end, commit, first text/audio/playback samples; currently no real samples or p50/p95 |
| Camera/screen Phase 2 | Not implemented. Record real voice baseline, then continue VISION_UPGRADE_PLAN.md |

Synthetic fixtures cannot clear these live rows. Conversation audio and current provider account access remain **UNVERIFIED**. The phase baseline is not complete.

## Resource and dependency observations

`test-results/resource-snapshot.json` records one Windows process snapshot after UI fixtures. It is not sustained idle/load profiling; initial CPU percentages are not a measured zero-CPU claim. Per-process working sets may share pages and should not simply be summed as unique memory. Physical performance under voice/wake load remains unverified.

The production dependency audit reported zero vulnerabilities. The full development-tool audit reported 25 moderate entries inherited from a minimatch glob-amplification advisory through lint/packaging tools. These tools operate on this controlled local project; no arbitrary user glob input is exposed by the app. No automatic major downgrade was applied. Recheck tool updates before distribution. This audit is not a complete security assessment.

## Packaging

Unsigned x64 portable and per-user NSIS artifacts are generated under `release`. Compression is set to store for reliable local packaging; outputs are larger. Python/wake models are optional separate installs; credentials/test profiles/recordings are excluded. Final file sizes and hashes are recorded by the package audit. Source is separately archived in the pack's `deliverables` directory.

The final asar excludes node_modules because all runtime dependencies are bundled; their license notices are included in dist. This removed unnecessary third-party source/tests found by the initial archive audit. The final archive audit passed.
