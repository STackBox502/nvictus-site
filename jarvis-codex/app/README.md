# Jarvis Codex

A Windows desktop AI voice companion with an original floating guardian, typed conversation, local memory and explicit audio controls. This is an independently built Codex implementation. The spoken assistant name is Jarvis.

**Status:** Phase 1 source is implemented. Credentials are intentionally deferred to local setup. Fixture, Windows UI and packaging results are recorded in TEST_REPORT.md. A fixture pass is not a passed live provider or hardware test. Phase 2 camera/screen capture is not implemented because its required real voice baseline has not been recorded.

## Launch

The preferred output is `release/Jarvis-Codex-0.1.0-portable.exe`. A per-user installer is also built when Windows packaging succeeds. See TEST_REPORT.md for the actual output. Builds are unsigned; no certificate was purchased. Follow your Windows organization policy rather than disabling OS protections.

From this `app` directory, with Node installed:

```powershell
npm ci
npm run build
npm start
```

`npm run dev` rebuilds then launches the same secure packaged origin. It does not run a Vite server or expose a localhost API. `npm run preview` starts an explicitly labeled visual preview with provider/device calls blocked until you exit it.

## Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | TypeScript validation |
| `npm run lint` | ESLint |
| `npm test` | Deterministic transport, queue, controller, persistence and IPC fixtures |
| `npm run build` | Production renderer + bundled Electron main/preload |
| `npm run smoke` | Windows Electron UI tests with Chromium fake microphone, never real capture |
| `npm run package:win` | Windows x64 portable + per-user NSIS installer |
| `npm run package:dir` | Unpacked Windows application |

Installed versions are pinned in package-lock.json. Initial runtime: Node 24.14.0 / npm 11.9.0. Electron 45.2.1, React 19.3.1, Vite 8.3.5, TypeScript 6.0.3. Provider transports use Node fetch and ws 8.22.1; no provider SDK or agent framework is required. Python is optional and used only for local wake detection.

Read SETUP_WINDOWS.md, CUSTOMIZATION.md, PRIVACY.md, ARCHITECTURE.md and TEST_REPORT.md. CODEX_HANDOFF.md in the pack root records the remaining work. No API credentials, recordings, or captured screens are distributed.

## Conversation Mode (0.2.0)

Press **◎ Start conversation** to talk back and forth with the microphone kept open. Speak over Jarvis to interrupt it. **Interrupt** stops it and keeps listening. **End conversation**, Stop, or Mute turn the microphone off. Speech is detected locally, and audio goes to ElevenLabs only while you're talking. Settings are under Audio → Conversation Mode. Details, the live test plan, and limits: `../CLAUDE_CONVERSATION_REPORT.md`.
