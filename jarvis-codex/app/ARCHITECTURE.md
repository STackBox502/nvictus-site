# Architecture

## Processes and identity

Electron 45.2.1 main owns one Controller, Repository, Vault, Providers transport and optional WakeEngine. A sandboxed React chat renderer owns the only microphone and Web Audio output graph. A second sandboxed, non-focusing transparent renderer displays the companion. Opening chat/overlay never starts a second provider or capture session. Both receive authoritative snapshots over a narrow preload bridge.

Identity: `Jarvis Codex`, app ID `com.nvictus.jarvis.codex`, data/lock `%APPDATA%\Jarvis Codex`. No runtime HTTP server or service port. Source development rebuilds local files and launches `jarvis://app`; Vite is a build tool only. Playwright uses temporary debugger ports for tests, never the packaged runtime. Windows source fixtures use isolated workspace profiles.

## Modules

- `src/shared.ts`: strict settings/command schemas, event and canonical message types.
- `src/core.ts`: segmentation, speech cleanup, bounded context, turn generation and safe errors.
- `src/main/controller.ts`: explicit state/event orchestration, one selected provider per turn, usage, interruption, voice activation and local commands.
- `providers.ts`: official HTTP/SSE Claude Messages/OpenAI Responses; ElevenLabs WebSocket realtime STT and HTTP streaming TTS. Network methods support dependency-injected fixture transports. No consumer sessions/cookies or coding subscriptions are used.
- `audio-output.ts`: maximum ten 100 ms packets outstanding; renderer playback completion gives credit. Cancellation invalidates pending acknowledgments.
- `storage.ts`: serialized atomic settings/memory/history writes and encrypted/session credential vault. No raw audio files.
- `wake.ts` / `wake/helper.py`: supervised fixed interpreter/helper paths, bounded stdin PCM, READY/WAKE/ERROR stdout only. No shell or arbitrary command protocol.
- `src/renderer/audio.ts` / `public/pcm-worklet.js`: one AudioWorklet capture/resampler and one ordered playback graph. Native file/dialog/import/exports remain in main.

## Audio and turns

Capture requests `audio` and explicitly `video:false`. Worklet averages channels and uses a stateful weighted box filter to convert the browser rate to 16 kHz signed little-endian PCM. Packets are exactly 1,280 samples (80 ms). Input IPC validates packet size, sequence, generation and sender. Startup buffering is capped at 25 packets; a stalled connection stops capture instead of accumulating audio indefinitely.

Scribe model `scribe_v2_realtime`, format `pcm_16000`, manual commit. Partial transcripts are display-only. Explicit finish, local silence endpointing, or the utterance limit triggers one commit. Only the committed transcript creates a conversation turn. The app does not reconnect/replay a broken utterance automatically. Main authenticates with a header; no permanent key reaches a renderer URL.

Claude uses Messages streaming; OpenAI uses Responses streaming with `store:false`. Model IDs are selected from account catalogs and remain editable through setup. Completion must be explicitly reported; malformed, truncated and incomplete streams fail honestly. No tools, automatic fallbacks, or billable retries are attached. Context is bounded by characters and message count. Saved memory has separate record/count bounds and is marked as untrusted context.

Text appears as it streams. Speech segments break on sentence-sized punctuation with abbreviation/decimal handling and a 320-character ceiling. Markdown/URLs/code are normalized for speech. Final flush ensures the tail is spoken. The HTTP TTS stream requests `pcm_24000`; odd byte boundaries are reassembled and bounded 100 ms packets are delivered in order. Raw PCM is converted to Web Audio samples, not treated as independently decodable MP3 fragments. Actual analyser levels drive glow. Speaking is reported on scheduled playback start, then ends after the queue drains. This is a renderer playback-clock measurement, not an external measurement of sound at the speaker.

Every turn has an ID and generation. Stop aborts LLM/TTS, closes STT/helper, releases input, clears output and invalidates old events. An interrupted message retains visible generated text and only completed speech segments are marked confirmed played. Partial spoken segments are conservatively not claimed heard in future context. Stop is processed locally, independent of an LLM.

Half-duplex releases input before playback. Push-to-talk interrupts first. Local wake is suspended during responses; after playback and a refractory interval it rearms or opens an explicitly configured short follow-up capture. No hands-free acoustic barge-in is claimed. These acoustic behaviors still need real speakers/headphones.

## Limits and lifecycle

LLM 90-second stream deadline, speech 45-second segment deadline, STT startup/final deadlines and utterance limits, output 6-second progress timeout. No automatic network retries. Session guards limit requests, TTS characters and STT connected duration. Provider token counts may be incomplete on failures; counters are not billing totals.

Lock/sleep/resume stop all audio and require explicit reactivation. Closing chat hides it; Quit ends workers/processes. Overlay work-area clamps handle disconnected displays and DPI events. Alpha-based pointer hit testing leaves transparent regions click-through; physical drag/click-through validation is separate from geometry fixture checks.

## Phase 2 boundary

The canonical controller/provider boundary can be extended with typed image attachments and source-generation IDs. None are implemented here. There is no camera/display grant or runtime image input path. VISION_UPGRADE_PLAN.md records the future extension and the real-voice baseline gate.

## Official references checked November 1, 2026

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) and [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage). Installed types confirm the asynchronous API shapes.
- [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
- [OpenAI Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses).
- [ElevenLabs realtime STT](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [streaming TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [models](https://elevenlabs.io/docs/overview/models).
- [openWakeWord](https://github.com/dscripka/openWakeWord), [published package metadata](https://pypi.org/project/openwakeword/0.6.0/).

Account availability, voice/model pairing and real end-to-end audio have not been verified by reading documentation or running fixtures.
