# Jarvis Codex handoff

CURRENT STATUS UPDATE (November 1, 2026): Chris explicitly reports that he fixed ElevenLabs billing and voice now works. Earlier billing/credential blockers below are historical. Continue with CLAUDE_START_HERE.md for the current code handoff and next task: natural conversation and spoken interruption using laptop speakers. No fresh paid speech test or full speaker acceptance test was performed after that user report.

Date: November 1, 2026. Source: `app/`. User explicitly chose **build now; configure credentials in the app later**. No real provider calls or hardware capture were performed. Claude's independent project was not inspected or modified. Synced project sources were untouched.

## Delivered implementation

Current installed version: **0.1.1**. Copy/paste fix adds native Edit and right-click text menus for API keys, voice IDs, chat and other fields. Verified 9 clipboard checks including an actual Windows menu Paste click with dummy text; all 36 existing tests, lint and build pass. Updated installer completed with exit code 0, the installed app bundle matches the audited release, and the desktop shortcut reopened a responding app. Evidence: `app/test-results/clipboard-source.json`, `app/test-results/installed-0.1.1.json`. Latest packages are `app/release/Jarvis-Codex-0.1.1-setup.exe` and `app/release/Jarvis-Codex-0.1.1-portable.exe`. The 0.1.0 source ZIP remains the older checkpoint; current editable source is in `app/`.

Electron/TypeScript/React Windows companion; original floating PNG; typed streaming Claude Messages and OpenAI Responses adapters; ElevenLabs realtime STT and streaming PCM TTS; one capture/playback owner; local Stop/mute/PTT controls; shared authoritative controller; cancellation/generation guard; bounded history; user-controlled memory; account catalog setup; local encrypted/session credential entry; usage guards; settings; tray/hotkey recovery; asset import; Orbit/Drift/Still and preview; optional supervised openWakeWord helper/setup.

Source and lockfile are in `app`. Windows artifacts are in `app/release`, with SHA256SUMS. Setup/customization/privacy/architecture/test reports are in `app`. `deliverables/Jarvis-Codex-0.1.0-source.zip` contains an editable source checkpoint and evidence, excluding dependencies, environments, secrets, test profiles and build binaries. The package audit and source archive checksum identify this checkpoint; no Git commit was invented.

## Evidence

- Typecheck, lint, production build and deterministic test suite.
- 36 unit/transport/controller tests, including ten fixture speech turns.
- 18 Windows UI checks, including fake mic lifecycle, actual PNG/WebP imports, real Windows encryption of a dummy secret, sandbox boundaries, transparency and overlay bounds.
- Optional Python/ONNX helper loaded and processed four seconds of zero PCM with READY, no WAKE and successful exit. Not a real detection test.
- Windows output build and packaged launch evidence: `app/test-results/packaged-smoke.json`, `app/test-results/package-audit.json`.
- Rendered UI screenshots were inspected. Known failures and fixes are recorded in TEST_REPORT.md.

## Not complete / not verified

The requested **real voice baseline is not verified**. Both runtime providers and ElevenLabs require local credentials/account model selection and explicit paid tests. Real microphone/speaker, wake-word, external-focus shortcuts, physical click-through/drag, multi-monitor/DPI, Bluetooth/unplug and lock/resume acceptance remain unverified. Half-duplex is implemented; automatic spoken barge-in is not enabled. Wake runtime is source-local for this build and needs optional installation for the packaged app. A cold-helper load/protocol pass is not a hands-free acceptance pass.

Phase 2 camera/screen vision is **not implemented**. The original specification requires the real voice baseline before that extension. The app has no camera/display grants or image-provider path. VISION_UPGRADE_PLAN.md preserves the next implementation sequence; VISION_TEST_REPORT.md and VISION_QUICKSTART.md state the current boundary.

No arbitrary command execution, computer control, business integrations, deployments, purchases, live credentials, raw recordings or private captured screens are included. Windows binaries are unsigned. The developer-tool audit findings and live limitations are recorded rather than hidden.

## Next concrete action

Latest live diagnosis (November 1, 2026, after the user replaced the key and voice): current saved key ends `fb1b`; user, subscription, models and voice-catalog requests return HTTP 200, and the selected voice is in the catalog. The account remains `past_due`. The user explicitly approved ONE short speech test. `scripts/test-elevenlabs-voice.mjs` sent “Jarvis voice test.” with the actual saved key, selected voice and `eleven_multilingual_v2`; speech returned HTTP 401 with invoice/payment indicators. No audio was generated. Evidence: `app/test-results/elevenlabs-live-test.json`. Do not replace the current working key or voice, and do not reimport the earlier CLI env credential automatically. The account owner must resolve the outstanding payment, then retry speech. The app's generic HTTP 401 credential text does not distinguish this billing rejection.

ElevenLabs onboarding follow-up: official SDK installed and used by `app/scripts/elevenlabs-onboard.mjs`. The gitignored CLI env key was validated and encrypted into the installed app's vault, with a prior encrypted backup. The running app has not been restarted to load it. Read-only checks confirmed the old key's missing permissions, a past-due subscription with open invoices, and an invalid configured voice ID (`voice_not_found`). The CLI now reports `offer_test`. No paid speech test was sent. The account owner needs to resolve billing; then restart Jarvis, reload the voice catalog and select the intended voice. On user approval run the CLI test and verify the in-app preview. Lint and typecheck pass for the added setup utilities. No renderer receives an env credential and no plaintext key was logged.

Jarvis is now installed for this Windows account at `C:\Users\falco\AppData\Local\Programs\Jarvis Codex\Jarvis Codex.exe`. Open **Jarvis Codex** from the desktop or Start menu shortcut, open Connections, configure Claude (or OpenAI) and ElevenLabs locally, select the account model and voice, save, then follow SETUP_WINDOWS.md. Quit the other companion before real audio tests. Record the ten-turn/interruption baseline in TEST_REPORT.md. Only after the required baseline is established should the next session implement Phase 2 in this same app.

Launch recovery, November 1, 2026: the portable build opened successfully when launched directly, so the original reported failure was not reproduced. Installed the existing tested build per user (installer exit code 0), verified desktop and Start menu shortcuts, then launched through the desktop shortcut and confirmed a responding window from the installed executable. No credentials were added and no capture was enabled. This installation note is newer than the source ZIP checkpoint.

Build commands: `npm ci`, `npm run build`, `npm start`; verification: `npm run typecheck`, `npm run lint`, `npm test`, `npm run smoke`; Windows packaging: `npm run package:win`. Do not overwrite user data or supplied specs when continuing. Preserve current source and compare against the source archive/checksums before changes.
