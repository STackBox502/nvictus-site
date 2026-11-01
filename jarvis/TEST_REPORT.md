# Test report: Jarvis v0.1.0

Run on **2026-11-01** in a Linux cloud container (Node 22.23, Python 3.13, Xvfb). There was **no Windows machine, no real microphone or speakers, and no API keys**, so **zero paid API calls were made**. Fixture and demo results are labeled as such and **do not count as live verification**.

## What actually ran

| Check | Result | Kind |
|---|---|---|
| `npm run typecheck` (main+preload+shared+tests, renderer) | ✅ pass | static |
| `npm run lint` | ✅ pass (2 intentional, commented exceptions) | static |
| `npm test`: 93 tests in 6 files | ✅ 93/93 | deterministic fixtures |
| `npm run build` (electron-vite production) | ✅ pass | build |
| Electron end-to-end smoke (`scripts/smoke-e2e.cjs`), real app under Xvfb, Chromium fake microphone, **Demo mode** | ✅ 24/24 | real app, simulated providers |
| openWakeWord helper against the real package and model (`hey_jarvis_v0.1.onnx`) | ✅ download, self-test (silence score 0.0), protocol, no false triggers in 2.5 s noise/silence, oversize frame rejected | real local model, synthetic audio |
| Windows cross-build `electron-builder --win portable --x64` | ✅ produced `Jarvis-0.1.0-portable.exe` (110 MB, unsigned); package contents audited (only `out/`, `ws`, `zod`, helper files; no `.env`, sources, tests, or maps from app code) | build only. **Not launched on Windows** |

### Unit/integration coverage (fixtures, mocked transports, fake audio clock)
- **State machine:** full voice turn, armed rest state, invalid transitions rejected, mute precedence, interrupt/settle.
- **Turn dedup and stale audio:** rapid duplicate submission ignored; late PCM after Stop never forwarded; renderer scheduler drops chunks for stopped/older turns.
- **Streaming segment assembly:** abbreviations, decimals, domains, token-by-token equals whole-text, soft split ≤ max, final flush, code fences across chunk boundaries, Markdown/URL cleanup.
- **Audio queue:** strict order when later chunks finish first, odd-byte alignment, bounded lookahead (2), cancel ⇒ no sink calls, failure reported once and stream ended.
- **Playback scheduler:** gapless back-to-back timing, started/chunkPlayed/drained events, stop silences immediately, newer turn supersedes older.
- **Providers:** Anthropic SSE (text, usage, headers, body), credit errors, mid-stream overload, missing `message_stop` ⇒ malformed, cancellation, idle timeout. OpenAI Responses (`store:false`, usage), `insufficient_quota`, `response.failed`, model filtering. Guarded fetch blocks non-allowlisted hosts before any request.
- **Controller:** typed turn end-to-end, Stop with heard-text context, push-to-talk commit flow, **transport boundary** (armed ⇒ frames only to wake detector; STT only after wake, with bounded pre-roll; "stop listening" closes STT and releases mic), half-duplex wake suppression, mute, local commands (remember/forget with confirmation/stop) with no LLM call, error + retry, transient retry before text only, TTS failure ⇒ "Voice unavailable" with text kept, budget guard, provider switch refusal and context-transfer note, unconfigured state, demo never marks live verification, suspend releases mic.
- **Context:** role alternation, notes and local commands excluded, interrupted replies ⇒ heard text only, count/char bounds, memories labeled as context.
- **Persistence:** encrypted keys never written in plaintext, masked status only, fail-closed without OS encryption, memory CRUD across reloads, corrupt file recovery, settings validation, history only when saved.
- **Security:** credential redaction (Anthropic/OpenAI/ElevenLabs key shapes, auth headers, bearer, query tokens, known values), endpoint allowlist, strict IPC schemas (unknown keys and channels rejected), trusted-origin rules, audio frame validation, prototype-pollution keys dropped.
- **Settings and visuals:** out-of-range patches rejected, per-section repair, privacy-safe defaults, motion bounds (bob ≤ amplitude, tilt ≤ 2°), clamps, still/reduced ⇒ no motion, energy driven by input only while listening and by output only while speaking. Geometry: docked default inside work area, monitor-loss recovery, clamping. Image header checks for PNG (RGBA/RGB/tRNS) and WebP VP8X, plus bad signatures and dimensions.

### Electron smoke checks (real app, Demo mode, Linux/Xvfb). Results in `docs/smoke-results.json`
Both windows load from `app://jarvis` · no Node globals in renderer · bridge exposes only `invoke,on,send,sendFrame` · unknown IPC channel and extra payload keys rejected · `window.open` denied · renderer `fetch` to a provider blocked by CSP · starts idle with **mic off** · **real wake helper starts and loads hey_jarvis** · demo reply reaches **speaking from real Web Audio playback** and returns to idle after drain · **Stop** interrupts and records heard text · mic capture starts with audio-only permission via the app's handler · **fake-mic frames flow through the AudioWorklet → IPC → STT** and produce a voice turn · mic released afterwards · hands-free arm (mic on, armed) and disarm (mic released) · mute · visual preview states · out-of-range settings rejected · "remember that…" persists · no credential file without keys · no renderer console or CSP errors · **Quit terminates the helper process**.

## Not verified yet (needs your Windows PC, hardware, or keys)

Each item lists the exact remaining check.

| Requirement | Status | Exact remaining check |
|---|---|---|
| Clean install launches without admin | ⏳ | Build or run `Jarvis-0.1.0-portable.exe` as a standard user. Confirm no UAC prompt |
| Transparent overlay on Windows DWM, click-through, drag, focus not stolen | ⏳ | Click through empty overlay areas into another app; drag by ⠿; trigger Talk via hotkey while typing in Notepad and confirm Notepad keeps focus |
| Overlay over full-screen apps | ⏳ | Observe with a borderless window and an exclusive full-screen app. Document the result |
| Monitor unplug / DPI change recovery | ⏳ | Move the overlay to a second monitor, unplug it, and confirm it reappears on the primary. Change display scaling |
| Tray recovery and Quit | ⏳ | Hide the character, restore it from the tray; Quit from the tray and confirm in Task Manager that no `Jarvis` or `python` processes remain |
| Global hotkey while another app has focus, plus collision fallback | ⏳ | Press Ctrl+Shift+Space in another app. Then register the same combo in another tool and confirm the fallback is shown in Setup |
| **Anthropic live turn** | ⏳ needs key | Setup → Test (free) → load models → send one typed message |
| **OpenAI live turn** | ⏳ needs key | Same with OpenAI selected |
| **ElevenLabs live STT and TTS** (`scribe_v2_realtime`, `eleven_flash_v2_5`, PCM 24 kHz) | ⏳ needs key | Voice preview, then one spoken question |
| 10 consecutive voice turns: no overlap, duplicate, lost last sentence, or stale audio | ⏳ | Ask 10 short questions in a row; listen for the last sentence of each; check the Chat tab for duplicates |
| Stop interrupts immediately; old chunks never resume (live) | ⏳ | Press Stop mid-sentence on a long answer and wait 5 s for silence. Setup step 7 then shows the ✓ |
| Speaker vs headphone feedback | ⏳ | Run a conversation on laptop speakers and on headphones in half-duplex. Note any self-hearing |
| **Real "Hey Jarvis" detection and false-activation rate** | ⏳ | Complete hands-free setup, arm, say "Hey Jarvis" 10 times at normal distance, then leave it armed 30 min with normal room noise and count false wakes |
| Wake barge-in (experimental) | ⏳ | Only after the above. Expect limits on speakers |
| Permission denial, no device, invalid key, depleted credits, network loss, sleep/resume | ⏳ | Deny mic in Windows privacy settings; unplug the mic mid-listen; paste a bad key; disable Wi-Fi mid-reply; sleep and resume (mic must stay off) |
| Speaking glow follows real playback; listening glow follows real mic (Windows) | ⏳ (verified on Linux with fake mic and demo tone) | Watch the overlay during a live conversation |
| Output device selection (`setSinkId`) | ⏳ | Choose a non-default output in Settings and play the test tone |
| Character import with your real PNG | ⏳ | Setup → step 5. Note whether the transparency warning appears (the preview in chat looked like a white background) |
| CPU and memory | ⏳ | Task Manager readings idle/armed/speaking. No numbers are claimed here |
| Packaged NSIS installer | ⏳ | `npm run package:win` on Windows, install per-user, uninstall |
| Latency p50/p95 | ⏳ | Shown in Usage after 20+ live turns. Only individual samples until then |

## How to re-run

```bash
npm run check
```

```bash
npm run build && SHOTS=out-shots JARVIS_SMOKE_PYTHON=/path/to/wakeword-venv/bin/python xvfb-run -a node scripts/smoke-e2e.cjs
```
