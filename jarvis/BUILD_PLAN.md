# Jarvis — Build Plan

Source brief: `JARVIS_Claude_Code_Build_Prompt.md` (START PROMPT … END PROMPT), prepared Nov 1, 2026.
Status checklist lives in `CLAUDE_HANDOFF.md` so a later session can continue without starting over.

## Workspace facts (inspected at build start)

| Item | Finding |
|---|---|
| Build host | Linux cloud container (no Windows, no microphone, no speakers, no API keys) |
| Repo | `stackbox502/nvictus-site`, branch `claude/dreamy-hopper-cmgd7c`. Jarvis lives in `jarvis/`, isolated from the website files |
| Node / npm / Git | v22.23.4 / 10.9.9 / 2.43.0 |
| Python | 3.13 (used here only to verify the wake-word helper) |
| Network | npm, PyPI, GitHub reachable. **elevenlabs.io docs blocked**, so ElevenLabs protocol details were read from the official `@elevenlabs/elevenlabs-js@2.75.0` SDK source on npm instead |
| Character PNG | Shared in chat but not as a file. The app ships with a labeled geometric placeholder and an importer |

## Credit-safety plan (no surprise spend)

Two separate budgets get protected: provider API credits (Anthropic / OpenAI / ElevenLabs) and Claude Code build usage.

**Provider API credits**
1. **This build session makes zero paid API calls.** No keys exist here. Every provider path is exercised with mocked transports.
2. **Demo mode**: simulated LLM, STT, and TTS with no network and no charges. You can click through the whole app, including talk, interrupt, and memory, before entering a single key. A persistent banner labels it, and it never counts as live verification.
3. **Visual preview mode**: cycles the character's states with simulated levels and no network.
4. **Free connection tests**: "Test" buttons call model-list and voice-list endpoints. These consume no tokens and no characters.
5. **Paid actions are opt-in and labeled**: the voice preview and the one-line voice test each show a "uses ElevenLabs characters" label before the button.
6. **Local budget guard**: per-day caps on output tokens, TTS characters, and STT seconds, plus a per-session turn cap. It's an estimate-based stop, not a provider billing cap. Real spend controls stay in each provider dashboard.
7. **Session limits**: max utterance length, listening timeout, max continuous STT connection, max reply tokens, bounded retries.
8. **Wake word runs locally.** Idle room audio never reaches a paid STT stream.
9. Cross-provider fallback is **off** by default, so one turn can't bill two providers.

**Claude Code build usage**
- No subagents. Minimal doc fetches (one SDK tarball instead of crawling docs).
- Code is written in large, planned modules, with no read-rewrite loops.
- Phased commits so nothing gets rebuilt if a session ends mid-way. `CLAUDE_HANDOFF.md` keeps the checklist.

## Architecture (summary, details in ARCHITECTURE.md)

- Electron 45 + TypeScript 6.0 + React 19 + Vite 8 via electron-vite 6. Runtime deps: `ws`, `zod` only.
- **Main process**: the single authoritative `ConversationController`, provider adapters (raw `fetch` + SSE), ElevenLabs STT (WebSocket via `ws`, key in header), ElevenLabs TTS (HTTP streaming, raw PCM), encrypted secrets (safeStorage), JSON stores, wake-word helper supervisor, tray, shortcuts, permission and navigation lockdown.
- **Overlay renderer**: the single audio engine (mic capture through an AudioWorklet resampling to 16 kHz PCM, gap-free Web Audio PCM playback, output analyser) plus the floating character.
- **Chat renderer**: chat, setup wizard, settings, memory, usage, diagnostics. It never captures audio itself.
- **Wake word**: openWakeWord "hey_jarvis" (ONNX) in an isolated Python helper, fed binary length-prefixed PCM over stdin and replying with JSON lines on stdout.

## Build sequence

1. Scaffold, configs, shared pure modules (state machine, chunker, SSE, context, commands, redaction, settings schema, image checks, motion math, usage), plus unit tests.
2. Main process: stores, secrets, providers, STT/TTS, TTS queue, controller, IPC (validated), windows, tray, shortcuts, permissions.
3. Preload bridge (narrow allowlist).
4. Renderers: overlay (character, trails, motion presets, audio engine) and chat (chat, setup, settings, memory, usage, diagnostics, preview).
5. Wake-word helper and supervisor, verified against the real openWakeWord package in the container.
6. typecheck, lint, tests, production build, Electron smoke launch under Xvfb (demo mode, screenshots), Windows cross-package attempt.
7. Docs: README, SETUP_WINDOWS, CUSTOMIZATION, ARCHITECTURE, PRIVACY, TEST_REPORT, CLAUDE_HANDOFF, asset manifest.

## Scope guard (excluded from v1, by instruction)

Camera, vision, screenshots, screen share, OCR, gesture/gaze/posture tracking, browser or computer control, shell execution, messaging, calls, email/calendar/CRM, invoices, file-indexing "second brain", knowledge graph, local LLMs (Ollama), Voice Studio, voice cloning. None of these get permissions, dependencies, or buttons.
