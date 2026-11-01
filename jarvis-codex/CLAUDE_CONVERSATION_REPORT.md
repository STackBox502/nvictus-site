# Conversation Mode: change report (Jarvis Codex 0.2.0)

Prepared by Claude (Claude Code), November 1, 2026, continuing the Codex project from `Jarvis-Claude-Handoff-2026-11-01.zip`. This is the same codebase. It was not merged with the separate Claude-built `jarvis/` project.

**Status:** implemented and verified with fixtures and a fake-microphone Electron smoke test. **Not yet verified on Chris's laptop speakers and microphone.** Live acceptance is pending (sequence below).

## What changed for you

- **◎ Start conversation / ■ End conversation** on the Conversation page, on the floating guardian, and in the tray menu. Once started, the microphone stays open and you talk back and forth.
- **Speak over Jarvis to interrupt.** Clear speech while Jarvis is talking stops its audio immediately, then your new request is answered. The first words of your interruption are kept.
- **Interrupt** button: stop Jarvis talking but keep the conversation going. The Talk hotkey does the same during a conversation.
- **■ Stop**, Mute, sleep/lock, settings save, and **End conversation** always turn the microphone off. Saying "end conversation" or "goodbye" also ends it.
- Saying "stop" or "wait" during a conversation stops Jarvis and keeps listening.
- A live status bar shows whether audio is only being analysed on your PC or **being sent to ElevenLabs** (only while you're talking).
- **Audio → Conversation Mode** settings: Interrupt by speaking (on/off), sensitivity (low/medium/high), and End after silence (default 5 min). The pause before Jarvis replies still uses "Silence before sending" (default 1200 ms).
- **Usage** now shows spoken interruptions with measured onset→stop times.
- Talk and Hold to talk are unchanged (half-duplex), as are wake word, credentials, appearance, copy/paste, settings, and memory.

## How it works

1. **Separate lifetimes.** A conversation owns one capture session (`captureGen`). Each reply has its own response generation (`gate.generation`). Cancelling a reply never invalidates the microphone. Stale capture, response, and ack events are still rejected by the generation that owns them.
2. **Speech detected locally** (`src/speech-detector.ts`, main process, 20 ms frames). A frame counts as speech only if it's louder than the adaptive noise floor, voiced (pitch-periodic), and not impulsive (keyboard clicks). A 600 ms calibration absorbs a hum present at the start. A flat, unchanging "turn" lasting 3 s is treated as fan or hum noise and released.
3. **Echo-aware barge-in.** Main knows the level of every 100 ms PCM chunk it sends, and the renderer reports when each chunk actually starts playing. While Jarvis plays, your speech must exceed *predicted echo* (playback level + learned speaker→mic coupling + margin) for about 280 ms of voiced speech (medium sensitivity). Coupling starts strict (0 dB), rises fast, and falls slowly, so the detector errs toward not interrupting itself. Browser echo cancellation stays on as the first layer.
4. **Immediate local stop.** On detection: new response generation, abort the LLM/TTS requests, flush the bounded output queue, send `cancel` to the renderer (stops scheduled sources at once), and reject late packets. This doesn't wait for a transcript or Claude.
5. **Bounded pre-roll.** The last 800 ms of mic audio is kept in RAM. A new utterance is sent from about 200 ms before the detected onset, so the first words survive.
6. **One turn, not fragments.** If you start talking again before the previous transcript returns, or while Jarvis is still thinking (nothing heard yet), both parts are joined into one request. The unheard reply is withdrawn.
7. **Honest context.** Interrupted replies keep the existing `heardText` rule: only fully played sentence segments count as heard.
8. **Brief acknowledgements.** "Yeah" or "mm-hmm" right after an audible interruption doesn't start a new paid request. Jarvis stays quiet and says so in the notice ("say 'go on'").
9. **Cost control.** Silence and Jarvis's own playback are never streamed to ElevenLabs. Speech-recognition time is tied to your actual speech plus a short pre-roll and the end-of-turn pause. Existing session limits (listening seconds, turns, speech characters) still apply. An LLM error, or two consecutive speech-service errors, ends the conversation with the mic off, so failures don't repeat paid attempts.

## Files

| File | Change |
|---|---|
| `app/src/speech-detector.ts` | **New:** speech detector, echo reference, backchannel check |
| `app/src/main/controller.ts` | Conversation Mode: capture/response separation, barge-in, utterance handling, merge, limits |
| `app/src/main/audio-output.ts` | Reports each played chunk's level (echo reference) |
| `app/src/main/index.ts` | `converse` / `end-conversation` controls, capture-generation validation for PCM and mic status, tray items, Talk hotkey → interrupt during a conversation, offline speech stub in `--test-mode` only |
| `app/src/main/providers.ts` | Realtime STT pre-connection buffer 25 → 60 packets (pre-roll + handshake) |
| `app/src/renderer/audio.ts` | No renderer-side silence commit in conversation capture mode |
| `app/src/renderer/main.tsx`, `style.css` | Buttons, live status, settings card, usage card |
| `app/src/shared.ts`, `app/src/core.ts` | Settings (`bargeIn`, `bargeInSensitivity`, `conversationIdleMinutes`), snapshot fields, usage interruptions |
| `app/tests/speech-detector.test.ts`, `conversation.test.ts`, `audio-fixtures.ts` | **New:** 22 tests |
| `app/scripts/smoke.mjs` | 3 new Electron checks for Conversation Mode |
| `app/package.json`, lockfile | Version 0.2.0 (no dependency changes) |

## Verification performed (Linux cloud container, no real audio hardware, no API keys)

| Check | Result | Kind |
|---|---|---|
| Baseline before changes | 36/36 tests, typecheck, lint | matches CLAUDE_VALIDATION.txt |
| `npm test` | **58/58** (36 original + 11 detector + 11 conversation) | fixtures |
| Mutation check: barge-in call disabled | the 4 interruption tests fail as expected; all pass when restored | test validity |
| `npm run typecheck`, `npm run lint`, `npm run build` | pass | static/build |
| `npm run smoke` (Electron, Chromium fake microphone, `--test-mode`, Xvfb) | **21/21** (18 original + 3 conversation) | real app, fake device, offline speech stub, **no provider calls** |

Fixture timings (synthetic voiced signals, packet-level clock; **not your room**):

| Sensitivity | Turn start after speech onset | Barge-in after you start talking over Jarvis |
|---|---|---|
| low | 220 ms | 360 ms |
| medium (default) | 180 ms | 280 ms |
| high | 140 ms | 220 ms |

Stopping audio after detection happens within one IPC hop in fixtures. In the controller fixture, onset → local cancel stayed within 450 ms. Real numbers appear in **Usage → Spoken interruptions** on your PC.

Fixture coverage: continuous capture across turns (mic never stopped), silence never streamed, echo-only playback never self-interrupts, talking over speech interrupts and keeps pre-roll, no late audio after cancel, honest heard-text context, merge while thinking, joined split sentence, backchannel, rapid repeated interruptions, Interrupt/Talk keep listening, End/Stop/Mute release the mic, stale capture rejected, re-entry, preview/mute refusal, "stop" vs "end conversation", repeated speech-service errors and provider errors end safely, barge-in off.

**Not verified:** real echo on laptop speakers, real acoustic latency, real ElevenLabs/Claude turns in this mode, device changes and sleep/resume on Windows, packaged installer.

## Update your PC (5 minutes)

1. Quit Jarvis Codex (tray → Quit). Back up two folders:
   - `...\JARVIS_Codex_Build_Pack\app`: copy it to `app-backup-0.1.1`. You can skip `node_modules`.
   - `%APPDATA%\Jarvis Codex\settings.json`: copy it to `settings-0.1.1.json`. 0.1.1 can't read settings that 0.2.0 has *saved*, so this lets you roll back cleanly.
2. Get the 0.2.0 source, using either option:
   - **Git:** branch `claude/dreamy-hopper-cmgd7c` of `STackBox502/nvictus-site`, folder `jarvis-codex/app`. Copy its `src`, `tests`, `scripts`, `package.json`, and `package-lock.json` over your `app` folder.
   - **Zip:** extract `Jarvis-Codex-0.2.0-source.zip` over the pack folder. It contains only source files. Your `node_modules`, `.env.local`, `release`, credentials, and data are untouched.
3. In PowerShell, inside the `app` folder, run these in order (dependencies are unchanged, so no reinstall is needed):

```powershell
& 'C:\Program Files\nodejs\npm.cmd' test
& 'C:\Program Files\nodejs\npm.cmd' run build
& 'C:\Program Files\nodejs\npm.cmd' start
```

`npm start` runs the source build with your existing saved keys, voice, and settings. The installed 0.1.1 stays as it is until you package and install 0.2.0 after the live test passes:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run package:win
```

Rollback: restore `app-backup-0.1.1` and `settings-0.1.1.json`, then use the installed 0.1.1.

## Live acceptance test (laptop speakers + mic, normal volume and distance)

Each spoken turn costs normal Claude + ElevenLabs usage. Keep answers short. The whole test is about 20 short exchanges.

1. **Baseline:** Conversation page → **◎ Start conversation**. The bar should say "listening on this computer". Stay silent for 20 s: no "sending" state, no reply.
2. **Ten short exchanges:** ask 10 short questions. Each should get one answer: no duplicate turns, no lost last sentence, and Jarvis never answers its own voice.
3. **Interrupt beginning, middle, end:** ask for a long answer three times. Talk over it right after it starts, in the middle, and near the end. Jarvis should go quiet fast, your first words should show up in your message, and the reply should address the correction without restarting the old answer.
4. **Interrupt while thinking:** ask a question, then add "and also…" before Jarvis starts speaking. You should see one combined message.
5. **Pauses:** say a sentence with a 1-second thinking pause in the middle. It should stay one turn. If it splits, raise "Silence before sending" to 1500–1800 ms.
6. **Acknowledgement:** while Jarvis talks, say only "yeah". It should stop and wait, without starting a new answer.
7. **Noise without speech:** type on the keyboard and make normal room noise while Jarvis speaks. It shouldn't interrupt. If it does, set sensitivity to **low**. If it ignores you, speak up or set it to **high**.
8. **Controls:** Interrupt, Stop, Mute, and End conversation should each work, with no late audio afterwards. Unplug and replug the mic, and lock/unlock Windows: the mic must stay off until you start again.
9. **Measure:** Usage → Spoken interruptions shows onset→stop samples. Report the median and any failures.
10. **Regression:** credential paste, typed chat, guardian/tray, and saved settings still work.

Headphones help isolate problems, but they don't replace the speaker test. Record results (with failures) in `app/TEST_REPORT.md`. Don't mark natural-conversation acceptance as passed until steps 2–8 pass on the speakers.

## Known limits (honest)

- Echo protection is learned, not perfect. The first seconds of the first reply in a session are the strictest. Very loud speakers or a quiet voice can block interruption (Interrupt and Stop always work). TV, music, or other voices in the room can trigger it.
- The detector is energy, voicing, and echo based, not a neural voice detector. Thresholds may need one tuning pass on your laptop.
- Heard text is still per sentence segment (a partly played sentence counts as not heard).
- Interruption is not available in Talk / Hold to talk modes (by design: they're half-duplex).
- Speech is streamed to ElevenLabs during your turn plus the end-of-turn pause. Very long monologues hit "Maximum utterance" (30 s default) and are sent as one turn.
