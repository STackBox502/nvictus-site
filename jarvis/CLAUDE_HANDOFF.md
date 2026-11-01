# Claude handoff: Jarvis

Read this first in any new session. It's the persistent checklist. Don't rebuild from scratch.

## Where things are
- Project: `jarvis/` inside `stackbox502/nvictus-site`, branch `claude/dreamy-hopper-cmgd7c`. It's isolated from the website files at repo root. Moving it to its own repo later is a plain folder move.
- Brief: `JARVIS_Claude_Code_Build_Prompt.md` (owner's upload; START/END PROMPT section). Plan: `BUILD_PLAN.md`. Results: `TEST_REPORT.md`.
- Commands: `npm ci`, `npm run check` (typecheck + lint + 93 tests + build), `npm run dev`, `npm run package:win:portable`.

## Status checklist
- [x] Scaffold: Electron 45 / electron-vite 6 / React 19 / TS 6.0; deps pinned; scripts
- [x] Shared pure modules + unit tests (state machine, chunker, SSE, errors, redaction, allowlist, IPC schemas, commands, transcript, context, motion, usage, geometry, image checks, settings)
- [x] Main: controller, Anthropic/OpenAI/Demo adapters, ElevenLabs STT (ws, header auth) and TTS (PCM stream), TtsQueue, stores, safeStorage secrets (fail-closed), IPC validation, windows, tray, shortcuts with fallback, permission and navigation lockdown, `app://` protocol, power/display events
- [x] Preload narrow bridge
- [x] Renderer: audio engine (AudioWorklet capture, PCM scheduler, analyser, sink selection, cue/test tone), overlay (Orbit/Drift/Still, trails, glow, compact badge, click-through, drag handle, context menu, status/wake/demo/preview labels), chat (chat, 7-step setup, settings, memory, usage, diagnostics)
- [x] Demo mode (no network) and Visual preview (simulated, labeled)
- [x] Wake-word helper + supervisor; verified against the real openWakeWord model locally (synthetic audio only)
- [x] Electron smoke test 24/24 (Linux/Xvfb, Demo mode); Windows portable cross-build OK
- [x] Docs: README, SETUP_WINDOWS, CUSTOMIZATION, ARCHITECTURE, PRIVACY, TEST_REPORT, this file, asset manifest
- [ ] **Owner on Windows:** every ⏳ row in TEST_REPORT.md (live keys, mic/speakers, wake word, overlay behaviour, installer)
- [ ] Import the owner's real character PNG (it was shared only inline in chat, so it isn't in the repo). Check transparency; the inline preview looked like a white background

## Known limitations / decisions (honest)
- **Global hotkey is press-to-start / press-to-send.** Electron `globalShortcut` has no key-up event. True hold-to-talk is on the on-screen button. A native key hook (e.g. uiohook) was deliberately not added.
- **Heard-text granularity is per speech chunk** (sentence-ish), based on `chunkPlayed`. It doesn't know the exact word.
- **Spoken barge-in** is only "Hey Jarvis" during speech (experimental, off by default). There's no raw-VAD barge-in, because it can't be made reliable on speakers without testing.
- **Custom wake models:** helper supports `--model-path`, but there's no in-app picker yet.
- **Per-state character images:** not implemented. All states use the master image.
- **No summarization** of old context. History is truncated by message and character bounds.
- `ws` STT connection doesn't use the Windows system proxy (Chromium `net.fetch` is used for HTTPS and does). Matters only on proxied corporate networks.
- Packaged build is unsigned. Default Electron `.exe` icon (add `build/icon.ico` to brand it).
- ElevenLabs docs host was blocked in the build container. The protocol was taken from the official SDK source (`@elevenlabs/elevenlabs-js@2.75.0`). Re-verify against live docs if anything misbehaves on first live run.

## Suggested next steps (in order)
1. Owner: build on Windows, import the PNG, run Setup with real keys, and record results in TEST_REPORT.md.
2. Fix anything found in live STT/TTS (most likely spots: STT error message types, voice settings support per model, `setSinkId`).
3. Optional: in-app custom wake model import, app icon, code signing, a native key hook for true global hold-to-talk.

## Ground rules carried from the brief
No consumer-site automation or account-session reuse. Official APIs only. No paid calls without the owner's action. Never claim live verification from fixtures. Never fabricate results. Keep camera, screen, and external-account features out of v1.
