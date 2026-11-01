# Architecture

## Processes

```
┌──────────────────────────── Electron main (Node) ─────────────────────────────┐
│ ConversationController (single source of truth: state machine, turns, memory) │
│  ├─ LLM adapters: Anthropic Messages SSE · OpenAI Responses SSE · Demo        │
│  ├─ ElevenLabs STT  (WebSocket via `ws`, key in xi-api-key header)            │
│  ├─ ElevenLabs TTS  (HTTPS stream per speech chunk → raw PCM) + TtsQueue      │
│  ├─ PythonWakeService (spawn, no shell) ──stdin PCM / stdout JSON──┐          │
│  ├─ SecretStore (safeStorage/DPAPI) · Settings/Memory/History/Usage│          │
│  ├─ guardedFetch: https + host allowlist                           │          │
│  └─ windows, tray, global shortcuts, permission + navigation lockdown         │
└───────────────▲─────────────────────────────────▲──────────────────┼──────────┘
     validated IPC (zod, sender + origin checks)   │                  ▼
┌───────────────┴──────────────┐   ┌───────────────┴───────────┐  ┌─────────────────────┐
│ Overlay renderer (sandboxed) │   │ Chat renderer (sandboxed) │  │ wakeword/helper.py  │
│ • THE audio engine:          │   │ • chat, setup, settings,  │  │ openWakeWord ONNX   │
│   mic → AudioWorklet 16 kHz  │   │   memory, usage, diag     │  │ (local only)        │
│   PCM playback scheduler     │   │ • never captures audio    │  └─────────────────────┘
│   output analyser            │   └───────────────────────────┘
│ • floating character         │
└──────────────────────────────┘
```

**One authoritative controller, one audio engine.** Opening the chat window never opens a second mic capture or provider session. The overlay window exists for the app's lifetime (`backgroundThrottling: false`), even when hidden, so audio keeps working. The chat window gets state snapshots by broadcast.

## Voice pipeline

`Mic → AudioWorklet (mono, low-pass, linear resample → 16 kHz Int16, 100 ms frames) → IPC (Uint8Array) → main → ElevenLabs realtime STT → TranscriptAssembler → ONE LLM turn → SpeechPipeline → TtsQueue → ElevenLabs TTS (PCM) → IPC → PlaybackScheduler → speakers`

- **STT transport:** `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad|manual`. It's opened from **main** with the key in a header. That means no key in the renderer, no key in a URL, and no single-use-token round trip. Protocol verified against `@elevenlabs/elevenlabs-js@2.75.0` (`input_audio_chunk` / `session_started` / `partial_transcript` / `committed_transcript` / error types). Audio sent before `session_started` is buffered (bounded). Under WebSocket backpressure, frames are dropped rather than buffered without limit.
- **Endpointing:** click, hotkey, and wake use server VAD commits. A turn finalizes once ≥1 committed segment exists, no partial is pending, and `endpointMs` of quiet has passed. Hold-to-talk uses manual commit on release. Partials are displayed but never submitted. No-speech, max-utterance, and max-connection timers bound every session.
- **TTS transport:** one HTTPS streaming request per *speech-sized chunk* (sentence-aware chunker that handles abbreviations, decimals, and URLs, with first-chunk fast-path and short-sentence merging; 260-char max), `output_format=pcm_24000`. PCM was chosen deliberately: each piece is Int16 → Float32 AudioBuffer, scheduled back-to-back on the AudioContext clock. That avoids the "independent compressed chunks can't be decoded" problem entirely. `previous_text`/`next_text` keep prosody continuous across chunks. At most 2 requests are in flight (lookahead), and audio is delivered **strictly in order**.
- **Speech text:** fenced code is dropped from speech while streaming ("I put the code in the chat"). Links, raw URLs, and Markdown syntax are cleaned. The chat shows the full text.
- **Why not the TTS WebSocket:** per-chunk HTTP gives clean per-chunk cancellation and retry semantics, works with the same allowlisted fetch, and avoids keeping a long-lived authenticated socket per turn. The latency cost is one request per sentence, partly hidden by lookahead.

## State machine (`src/shared/stateMachine.ts`)

`unconfigured · idle · armed · listening · transcribing · thinking · speaking · interrupted · muted · error`. A pure transition function rejects invalid events. **Speaking** starts when the renderer reports audible playback (scheduled start + output latency) and ends on `playbackDrained`, not when text finishes. Mic permission, connection status, and wake status are tracked separately.

## Turns, interruption, stale audio

- Every turn has an id. The sink drops PCM for any turn that isn't current. `stopPlayback(turnId)` raises the renderer's minimum accepted turn, so late chunks can never resume.
- Interrupt (Stop, hotkey, Talk during speech, wake barge-in, mute, new turn): abort the LLM stream, cancel the TtsQueue (aborts in-flight requests, no further sink calls), stop all scheduled sources immediately, close any STT session.
- The assistant message keeps its full text for display, but `heardText` holds only the chunks whose audio finished playing (`chunkPlayed`). Future context sends `heard text + "[Interrupted…; the rest of this reply was not heard.]"`.
- Retries happen only **before any text arrived** and only for retryable errors (rate limit, outage, network, timeout): 2 attempts at 0.8 s and 2.5 s. They never replay speech. Fallback to the other provider is off by default.

## Wake word

- Armed mode: the controller routes mic frames **only** to `PythonWakeService.feed` (re-framed to 1280-sample / 80 ms frames, length-prefixed on stdin). STT sessions exist only while listening. That boundary is enforced in `onAudioFrame` and covered by tests.
- On detection: an optional local cue, then listening opens with ≤`preRollMs` (default 600 ms) of in-RAM pre-roll, so "Hey Jarvis, what's…" keeps the command. A leading "Jarvis" in the transcript is stripped.
- Suppression: during thinking or speaking in half-duplex mode, for `refractoryMs` after playback, and while muted. Mute and "stop listening" stop feeding and release the mic.
- Supervisor: no shell, minimal env, bounded stdout line parsing (whitelisted message types), drop-on-backpressure, up to 3 restarts per minute, graceful stop (zero-length frame), then kill.

## Overlay window

Transparent, frameless, skip-taskbar, optional always-on-top (`floating` level), `showInactive()` so it never steals focus. Click-through: `setIgnoreMouseEvents(true, {forward:true})`; hovering a real control switches it off. Dragging uses a handle that polls the cursor in main. That's more reliable than `app-region: drag` combined with click-through, which swallows the mouse-leave events needed to restore click-through. Placement is pure math (`src/shared/geometry.ts`): docked default inside the work area (taskbar excluded), saved position clamped, recovery on display add/remove/metrics change.

## Security model

- `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webSecurity`, no webview. Renderer pages are served from a custom `app://jarvis` scheme mapped to the packaged `out/renderer` with path-traversal checks.
- Strict CSP: `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; …`. Assets are never inlined (the worklet must load from `'self'`). In dev only, a Vite plugin relaxes `script-src`/`connect-src` for HMR.
- Preload exposes `invoke`/`send`/`on`/`sendFrame` with fixed channel allowlists, nothing else. Main validates **every** payload with strict zod schemas (unknown keys rejected), checks sender webContents and origin, and accepts audio frames only from the overlay.
- Permissions: only `media` with audio-only types from the trusted origin. Camera, display capture, geolocation, devices (HID/serial/USB), and everything else are denied. `window.open` is denied, navigation is blocked, external links open only from a fixed key→HTTPS map.
- Network: main-process `guardedFetch` allows only `https://api.anthropic.com`, `https://api.openai.com`, `https://api.elevenlabs.io` (no redirects, no credentials in URL, port 443). STT `wss://api.elevenlabs.io` is checked the same way.
- Secrets: main-only. safeStorage async APIs (DPAPI on Windows). If encryption is unavailable (or Linux `basic_text`), persistence fails closed and session-only entry is offered. Renderer sees masked status only. All errors and logs pass through `redact()` (key patterns, auth headers, query tokens, known secret values).
- No telemetry and no crash reporter. Logs hold event codes only.

## Module map

| Path | Responsibility |
|---|---|
| `src/shared/*` | Pure logic used everywhere and unit-tested: types, settings schema/defaults, state machine, speech chunker, SSE, errors, redaction, endpoint allowlist, IPC schemas, local commands, transcript assembly, context building, motion math, usage/budget, geometry, image header checks |
| `src/main/controller.ts` | Conversation orchestration |
| `src/main/providers/*` | Anthropic / OpenAI / Demo adapters behind one `LlmAdapter` contract (normalized `text`/`usage`/`done`, cancellation, typed errors) |
| `src/main/speech/*` | ElevenLabs STT, TTS, voice/model metadata; Demo STT/TTS |
| `src/main/ttsQueue.ts` | Ordered, bounded, cancellable TTS |
| `src/main/wakeword.ts` | Wake helper supervisor + framing |
| `src/main/{secrets,stores,fsutil,log,assets,diagnostics,windows,ipc,index}.ts` | Persistence, security, shell |
| `src/preload/index.ts` | Narrow bridge |
| `src/renderer/src/audio/*` | Capture worklet, playback scheduler, audio engine |
| `src/renderer/src/overlay/*` | Floating character |
| `src/renderer/src/chat/*` | Chat, setup, settings, memory, usage, diagnostics |
| `wakeword/helper.py` | Local openWakeWord helper |
| `tests/*` | Vitest suites; `scripts/smoke-e2e.cjs` Electron end-to-end smoke (Playwright, Demo mode) |
