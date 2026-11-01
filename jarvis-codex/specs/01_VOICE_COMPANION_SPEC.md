# Jarvis voice companion — Codex master build prompt

Prepared for Chris Conley • November 1, 2026

Implementation specification for Phase 1. Read this through CODEX_START_PROMPT.txt. The original character is included at assets/jarvis-character.png. Build source under app/; this package contains instructions and assets, not a finished application.

## START PROMPT

You are my AI-directed development partner. Build and verify a working Windows desktop voice companion named Jarvis. Implement the app, run appropriate checks, fix failures, and deliver setup instructions and a runnable Windows build. Do not stop after a plan or scaffold. Work incrementally and preserve existing work. Inspect any repository instructions first. When credentials or hardware checks are unavailable, finish everything that can be completed with deterministic fixtures, then accurately identify the remaining live checks.

### 1. Goal and boundaries

I want to speak naturally to a personal assistant, hear an ElevenLabs voice answer, and see my original character float at the side of the desktop. Claude is the default conversation provider. OpenAI is a selectable alternate, labeled “OpenAI” with the exact selected model in settings. Codex builds the application; it is not automatically the application's conversation backend.

Use the official Anthropic and OpenAI APIs for the runtime. Do not automate consumer chat websites, scrape browser cookies, reuse ChatGPT or Claude account sessions, or assume a coding subscription supplies API access. Keep provider credentials and billing separate. Do not buy services, provision paid resources, connect business accounts, publish, or deploy this application without my instruction.

This first version is a voice conversation companion with an original floating character, typed chat, basic user-controlled memory, provider switching, settings, and reliable audio controls. Exclude camera access, image recognition, screenshots, screen sharing, OCR, gesture tracking, gaze/posture monitoring, focus surveillance, browser control, computer control, arbitrary shell execution, remote messaging, phone calls, email/calendar/CRM integrations, automatic invoices, a file-indexing second brain, and a 3D knowledge graph. These appear in the inspiration videos but are outside my requested first version. Do not create their permissions, dependencies, or misleading buttons.

Use these videos for inspiration, not as source code dependencies:
- https://www.youtube.com/watch?v=mitzci4FsOg
- https://www.youtube.com/watch?v=BgpRjk4Yoqk

The videos show a browser-based assistant. My desktop overlay is an intentional customization. Do not claim the creator used Electron or that we have their proprietary code or prompt pack.

### 2. Architecture and development setup

Use Electron with TypeScript, React, and Vite for Windows. Choose current mutually compatible stable dependencies after reading official documentation. Pin installed versions in the lockfile. Keep a small module structure, with separate Electron main, preload, renderer, provider adapters, audio orchestration, persistence, settings, and tests. Prefer a minimal dependency set over an agent framework. No cloud backend, Docker, database server, or GPU requirement for the core cloud-backed app.

The Electron main process owns provider API calls and secrets. The renderer handles microphone capture, transcript display, audio playback, and animation through a narrow validated preload bridge. Keep the overlay and chat/settings windows synchronized through one authoritative conversation controller; never open a second microphone capture or provider session simply because another window opens. Use workers/utility processes for heavy work. Do not block Electron's main thread with audio processing or model inference.

Provide npm scripts for development, typecheck, lint, meaningful tests, and Windows packaging. Inspect Node/npm/Git availability and report missing prerequisites with official installer links. Do not overwrite unrelated folders or change system-wide settings. Use Windows-compatible commands and paths. Provide a normal-user portable Windows build first, and an installer if packaging works. Report unsigned-build status accurately and never instruct me to bypass OS protection. Record versions and the final architecture in README.md and ARCHITECTURE.md.

### 3. Real voice pipeline

Implement this flow:
Microphone → ElevenLabs speech-to-text → one selected LLM → ElevenLabs text-to-speech → selected audio output.

Use ElevenLabs realtime speech-to-text with the currently supported Scribe realtime model, and a compatible low-latency ElevenLabs TTS model. Verify exact identifiers, SDK methods, audio formats, supported voice settings, and streaming limitations against current official documentation. Model IDs belong in validated configuration, not scattered through the UI. Reject incompatible voice/model selections with a useful explanation. Never substitute a different paid provider silently.

Prefer routing long-lived authenticated speech connections through main. If a renderer-to-ElevenLabs connection is justified, use the documented short-lived scoped token mechanism; never expose a permanent provider key in renderer bundles, localStorage, URLs, or logs. Explain the selected transport in ARCHITECTURE.md. Prefer app-internal IPC over an exposed localhost API. If a local service becomes necessary, bind only to loopback, authenticate requests, validate origin and payloads, and stop it on application exit.

Stream microphone audio in the exact format required by the speech endpoint. Handle resampling, mono conversion, buffering, packet ordering, and backpressure. Keep a bounded local pre-roll buffer where needed so activation does not clip the first word. Discard ambient pre-roll beyond the short activation window; do not write it to disk. Distinguish partial transcripts from committed segments. Trigger one LLM turn only after a finalized user utterance; combine segmented transcripts into a turn with explicit endpointing rules. Do not submit every partial transcript.

Stream visible LLM text immediately. Send complete speech-sized chunks to ElevenLabs while the rest of the answer is generated. Avoid one TTS request per token. Respect abbreviations, decimals, punctuation, and maximum chunk sizes. Keep one ordered playback queue, bounded buffering, and a final flush so the last sentence is spoken. Verify the chosen media playback path can actually decode and play the streaming format on Windows; do not assume arbitrary compressed chunks can be played independently. Convert Markdown to sensible speech: omit syntax, avoid reading raw URLs, and keep useful content in the transcript.

Use Anthropic Messages streaming for Claude and the current OpenAI Responses API for OpenAI. Provide a shared adapter contract with normalized text events, cancellation, usage metadata, completion/error status, and safe handling of unsupported features. Select an available low-latency model through setup using current provider documentation/account access. Do not hardcode a model name from a video and assume it exists for this account. Display the active provider/model visibly. Use one provider per turn; switching providers must never duplicate requests or cost. Cross-provider fallback is off by default, and must be explicitly enabled because it sends conversation text to another provider.

### 4. Turn-taking, interruption, and failure handling

Use an explicit state machine: unconfigured, idle, armed, listening, transcribing, thinking, speaking, interrupted, muted, and error. Add separate connection and mic-permission status where useful. Drive UI state from real events. Speaking begins with actual audible playback and ends when playback drains, not when text finishes generating.

Every session and turn needs an identity/generation counter. On cancellation or interruption, stop audible output immediately, abort LLM/TTS work where supported, close/reset per-turn speech contexts, empty queued audio/text, and discard late chunks from prior turns. Keep long-lived services only when safe. Preserve already heard content and mark interrupted assistant replies clearly so future turns do not imply that unspoken material was heard. Prevent overlaps, duplicate submissions, and replay of stale chunks after reconnect.

Provide a visible Stop button and configurable global shortcut. Clicking push-to-talk while Jarvis speaks interrupts first and starts a new utterance. Add a tested conversational mode with VAD/echo cancellation for spoken barge-in when feasible; do not claim acoustic echo cancellation makes speaker feedback impossible. Provide a reliable half-duplex setting that stops transcription/wake activation during playback, plus push-to-talk interruption. If hands-free interruption cannot pass actual speaker tests, clearly show its limitation and default to the reliable mode. Never let Jarvis continuously hear and answer its own voice.

Microphone requests must use audio only, with video explicitly false. Offer microphone selection, input level, output volume/mute, and output device selection where supported. If per-app output selection is unavailable on the target runtime, label system default and explain how to choose an output through Windows. Recover cleanly from unplugged devices and Bluetooth changes; prompt before switching to a different input. Release tracks, handlers, sockets, workers, and timers on stop/quit and suspend appropriately on Windows lock/sleep. Start with the microphone off after launch/restart/resume until I activate it.

Handle denied microphone permission, silent input, no configured device, unavailable credentials, invalid voice/model, authentication failure, exhausted credits, rate limits, provider outages, timeouts, internet loss, and malformed/partial responses. Use bounded retries with backoff only where a retry cannot replay speech or create duplicate turns. Do not retry indefinitely. Preserve my text input and offer explicit retry. If TTS fails, keep the text answer and show “Voice unavailable”; do not silently change voices. If STT fails, typed chat remains available. Never display success for an uncompleted provider operation.

### 5. Activation modes and wake word

Deliver reliable click-to-talk and push-to-talk first, then hands-free activation as part of the scoped build. Default configurable hotkey: Ctrl+Shift+Space if available, with a safe alternative when another application owns it. Provide a tray action to recover all controls if a global shortcut fails.

Hands-free wake word must run locally rather than sending continuous idle room audio to a cloud speech service. Start with “Hey Jarvis” using a supported local keyword detector. Investigate openWakeWord with ONNX on Windows as the first candidate; verify actual current package compatibility, included keyword model, artifacts, and licenses. A small isolated Python helper is acceptable only for local keyword detection if it is the simplest reliable Windows path. Communicate PCM over bounded IPC/stdin/stdout with a strict protocol, not arbitrary command execution. Pin dependencies, supervise startup/shutdown, and package or document this optional runtime cleanly. If an equally reliable supported Node/WASM path is simpler, document and use it instead.

Do not force Ollama, a local conversation model, Voice Studio, a new paid wake-word vendor, or a new cloud account into this build. If a working local wake-word engine requires an unavailable runtime/model, complete all other features, disable the hands-free toggle with an honest explanation, and record exactly what remains. Do not mark hands-free passed on synthetic events alone. Do not represent a typed phrase field as arbitrary custom wake-word training. Support custom keyword models by import only if validated compatible; otherwise document that a new wake phrase needs its own model.

Show a persistent “Listening for wake word — local only” indicator when armed. When a wake event occurs, reveal the character, optionally play a short configurable cue, and capture the command through cloud STT. Handle both “Hey Jarvis” followed by a pause and “Hey Jarvis, [command]” without losing the command. Suppress false activations during Jarvis playback and add a brief configurable refractory interval. Provide a follow-up conversation window with timeout, after which it returns to local-only armed mode. “Stop listening” must disarm and close cloud audio immediately. Mute must also stop local wake detection and release the microphone. Document that the currently active command audio and conversation text go to configured cloud providers; local wake detection does not make the full system offline/private-to-device.

### 6. Desktop overlay and interaction

Create a separate transparent frameless companion window with an optional always-on-top setting and a normal chat/settings window. Default to the right side, vertically centered or slightly below. Support left/right docking, dragging by a defined handle, resizing through settings, opacity, display selection, and remembering position. Clamp coordinates to the current display work area and recover when a monitor disconnects or DPI changes. Do not steal keyboard focus during activation. Keep room for the taskbar. An Electron overlay may not appear above exclusive full-screen applications; document observed Windows behavior rather than promising universal overlay support.

Default behavior: compact companion badge when idle; character gently reveals on activation, stays while listening/thinking/speaking, and collapses after a configurable delay. Offer always visible, on-demand, and hidden modes. Keep microphone state visible through tray/controls even when the character is hidden. Hide and mute are separate actions and must be labeled clearly.

Transparent regions should pass clicks to underlying apps while actual controls remain clickable. Implement Windows hit handling safely and test it; preserve a tray/hotkey recovery route. Give drag handles app-region:drag and controls app-region:no-drag where appropriate. Avoid a large invisible window intercepting work. Clicking the character opens chat; a context menu provides Talk, Stop, Mute, Hide, Settings, and Quit. Distinguish close-to-tray from Quit. Quit must stop audio capture, provider work, and helper processes. Launch-at-login is off by default and user-controlled.

### 7. Original character and floating animation

Use my supplied AI-generated transparent PNG as the master character. The look is an original falcon-inspired synthetic guardian: charcoal black metal, warm gold edges, violet illuminated eyes and seams. Do not reproduce the video's blue face, circular Jarvis HUD, logo, or actor likeness. Do not generate replacement images or consume image/video API credits. If the asset is not yet attached, build the asset importer and use an explicitly labeled geometric placeholder until I supply it.

Import through a file picker supporting transparent PNG/WebP first. Validate file signatures, dimensions, size limits, and decode success. Copy approved assets to the application's user-data folder rather than retaining fragile external paths. Render with contain behavior, preserving alpha and aspect ratio. No black rectangle, distorted face, or opaque backing panel. Allow master image replacement without a code edit. Optional per-state image overrides may reuse the master when unset; do not require five separately generated assets.

Implement a distinct floating style using code, not a looping generated video. Default “Orbit”: slow vertical bob of approximately 6–10 px over 4–6 seconds, tiny tilt of at most 1–2 degrees, and two thin offset gold/violet elliptical energy trails behind the character. Keep the face sharp and readable. Add “Drift” with gentle lateral motion and soft glow, and “Still” with motion disabled. These are motion presets around the same character. Expose speed, amplitude, glow, scale, orbit visibility, and accent colors in settings. Clamp values to prevent clipping/flashing.

Visual state behavior:
- Idle/armed: subtle movement, low-intensity glow; no fake speaking animation.
- Listening: a clear status label and smooth input-level response using actual microphone levels.
- Thinking: a slow orderly trail sweep; do not use microphone levels as pretend reasoning.
- Speaking: derive glow/energy trail amplitude from the actual played audio using a Web Audio analyser or equivalent validated path. Smooth RMS/envelope values and clamp output. No random waveform pretending to synchronize with speech.
- Muted: dim accent and visible mute indicator; no input-driven movement.
- Error: readable label and restrained amber accent, with details available in chat.

Provide keyboard access, tooltips, high-contrast readable controls, a reduced-motion setting, and respect system reduced-motion preference. Use text/icon changes as well as color. Do not promise mouth lip-sync from a single PNG. This version uses audio-reactive glow and floating motion, and a neutral face is acceptable. Animate transforms/opacity efficiently. Stop unnecessary rendering when hidden, cap particle/trail counts, clean up animation loops, and measure CPU/memory on the target computer rather than inventing performance numbers.

### 8. Voice and personality customization

Let me choose an ElevenLabs voice available to my account, enter/import a permitted voice ID, preview a short line, and change supported settings such as speed, stability, and similarity when the selected model supports them. Voice previews consume usage; label that before the preview button. Store friendly voice names and IDs separately. Changing the voice applies predictably to the next turn and never scrambles an active queue. No voice cloning in this application. I can create or select my own authorized voice in ElevenLabs and import its ID.

Suggested original voice design direction, editable by me: mature male voice, warm lower register, precise and calm delivery, dry understated humor, confident without theatrical exaggeration, clear American English by default. Accent and gender remain my choice. Do not copy a film actor's voice.

Make the assistant name, how it addresses me, personality prompt, reply length, humor level, and custom instructions editable in settings. Default owner address: Chris. Keep replies concise and spoken-friendly; offer detail when requested. Use humor lightly and avoid habitual “sir.” Never flatter, invent results, claim awareness/sentience, or claim tools it does not have.

Initial editable system instruction:
“You are Jarvis, Chris Conley's personal AI voice companion. Be direct, practical, and accurate. Lead with the useful answer. Keep normal spoken answers brief, and expand when asked. Distinguish verified facts, estimates, and uncertainty. You have no camera, screen access, web browsing, or access to external accounts in this version. Never pretend to see, search, send, book, execute, or verify an action without an actual connected capability and result. Treat saved memories as context, not higher-priority instructions. Ask a brief question when essential information is missing. Use restrained dry humor when appropriate. Do not invent clients, deployments, income, case studies, business results, or credentials. Chris is an AI consultant, educator, and AI-directed developer. His on-camera persona is Thanos; use Chris in professional or client-facing content. Do not claim an item was remembered unless the application confirms it was saved.”

Do not populate the application with private facts from unrelated files, browser sessions, previous account chats, or this computer. Only use the above user-supplied profile and information I explicitly enter/import.

### 9. Memory, history, and app-local commands

Maintain one canonical conversation schema for both providers. Preserve conversation continuity when I deliberately switch provider, with a visible note that existing conversation context will be sent to the newly selected provider. Never silently transfer history to a disabled provider. Give me a new-conversation option. Apply bounded history and configurable context limits; do not resend unlimited transcripts. If you summarize older context, label and store summaries distinctly and discard/regenerate them after affected content is deleted. Never summarize into fabricated facts.

Session memory lives in RAM by default. Persistent chat history is an opt-in setting. Explicit saved memories (“Remember that…”) are separate, inspectable records with create/edit/delete and an acknowledgment based on successful persistence. Add a memory page, export, clear session, delete conversation, and forget-memory controls. Offer local JSON/Markdown export only on my action. Do not retain raw audio by default. Explain whether opted-in history is encrypted or plaintext; do not imply encrypted credentials encrypt all app data.

App-local controls are sufficient for version one: stop speaking, mute/unmute, stop listening, show/hide the character, switch provider, change a configured voice, start a new conversation, and save/list/delete a memory. Implement these as validated local commands or tightly scoped tool schemas, never arbitrary model-generated code. Prioritize Stop and Mute without waiting for an LLM. Destructive history/memory clearing needs a clear UI confirmation. If spoken command matching is uncertain, confirm rather than guessing. A question about an unavailable external tool should receive an honest answer with no fake success.

### 10. Settings and setup experience

Provide a clean first-run flow:
1. Explain the separate roles of Claude/OpenAI and ElevenLabs and that API usage can incur charges.
2. Configure Anthropic and/or OpenAI credentials; only one is required to start. Configure ElevenLabs for voice. Each connection gets its own status and test button. Full voice capability requires a selected LLM plus STT/TTS access.
3. Validate model and voice choices against actual account access and documented support.
4. Choose microphone/output, test recording levels, then use one clearly labeled short paid voice test on my action.
5. Import my character and preview the three animation presets without API calls.
6. Choose click-to-talk, push-to-talk, or configure/test local hands-free.
7. Complete one real conversation and an interruption test before calling voice setup verified.

Expose connection/credential controls, provider/model, voice/settings, activation/hotkeys, input/output, endpointing, character/motion, overlay, personality, memory/privacy, usage, and diagnostics. Distinguish missing credentials from internet outage. Do not make users edit source files to change common settings. Include a reset-to-defaults action for non-secret settings without silently deleting credentials or memories.

### 11. Credentials, local security, and privacy

Keep credentials exclusively in the main process after setup. Use Electron's currently supported OS-backed safeStorage APIs on Windows, with availability/error handling; if encryption is unavailable, fail closed for persistent secrets and offer session-only entry. Verify the chosen Electron version's API shapes. Do not promise this protects against all programs running as the same Windows user. Never persist keys in renderer storage, ordinary settings JSON, exported diagnostics, logs, screenshots, or the packaged application. Allow credential replacement/deletion and show only masked status. Development env-file support is acceptable if ignored by Git and never packaged; provide an empty example with variable names only.

Use contextIsolation, sandboxing, nodeIntegration:false, a restrictive CSP, validated IPC schemas/senders, strict file-import boundaries, and local packaged content. Do not expose fs, shell, raw ipcRenderer, exec, unrestricted file reads, or generic network proxies through preload. Do not render LLM HTML unsanitized. Block unrequested navigation/new windows and validate any explicit HTTPS external link. Microphone permission handlers must allow only the app's trusted origin and audio capture. Deny camera, display capture, geolocation, and unrelated permissions. Do not weaken webSecurity to make an integration work.

Use an authenticated official provider endpoint allowlist. Redact authorization fields and potentially secret URLs from all errors. Disable telemetry and crash uploads by default. Diagnostics export should include versions, selected non-secret model IDs, device status, timing/error codes, and redacted connectivity info; omit conversation content unless I explicitly include it. Explain cloud audio/text transmission clearly without claiming unverified provider retention guarantees.

### 12. Usage, budgets, and performance

Track actual provider-reported token usage where available, STT session duration, TTS characters or reported usage, and per-turn timings. Clearly label app estimates and incomplete usage data. Do not claim app counters equal provider billing. Do not invent exact monthly costs or quote model-only latency as end-to-end response speed. Provide configurable local session limits for utterance length, response length, active listening timeout, retries, and maximum continuous connection duration. A local budget guard can stop new requests at an estimated threshold, but document pending requests and provider reporting lag; it is not a guaranteed provider billing cap. Link provider dashboards for actual billing/spend controls.

Instrument end-of-user-speech → committed transcript → first LLM text → first audio received → first audible playback. Measure p50/p95 only if enough actual samples exist; otherwise report individual samples and sample count. Target responsive conversation and immediate local stopping, but report measurements honestly. No claim of “instant,” guaranteed sub-second responses, or a five-minute complete build.

### 13. Verification and acceptance criteria

Write meaningful tests for state transitions, turn deduplication, streaming segment assembly, audio queue cancellation/late chunks, provider adaptation, context switching, memory persistence/deletion, credential redaction, IPC validation, and settings constraints. Use mocked transports/audio clocks for deterministic coverage. Include a clear visual-preview mode with simulated states and no network calls. It must be visibly labeled and never count as live verification.

Run typecheck/lint/tests and the production build. Launch the app on Windows if available, verify transparent overlay behavior, focus/drag/click-through/recovery, tray/quit, monitor/DPI position recovery, and asset import. Record screenshots without secrets. Conduct manual live-audio checks only when credentials, microphone/speaker, and user activation are available. Do not quietly incur extended paid testing.

Acceptance checklist:
- A clean documented install launches without administrator privileges.
- Only microphone audio is requested. No camera/display capture APIs or external-account permissions exist.
- Both configured LLM providers can complete a real turn independently; unconfigured alternatives remain honestly unavailable.
- Ten consecutive voice turns do not overlap, duplicate, lose the last sentence, or leave stale audio playing.
- Push-to-talk works while another application has focus and handles shortcut collisions.
- Stop interrupts playback immediately and old chunks never resume.
- Speaker/headphone feedback and hands-free false activation are tested and reported separately.
- Local wake-word mode sends no idle microphone audio to cloud endpoints; verify transport boundaries, not just labels.
- Permission denial, no device, invalid key, depleted credits, network loss, sleep/resume, and retry paths leave the app controllable.
- Speaking animation follows actual playback; listening animation follows mic input.
- Character import, all motion presets, reduced motion, sizing, docking, hide/show, and tray recovery work.
- Secrets do not appear in bundles/logs/exports. Session-only history and opt-in persistence behave as documented.
- Quit closes captures, sockets, workers, and helper processes.
- Every untested requirement is marked unverified with the exact remaining check.

### 14. Build sequence and deliverables

First inspect the workspace and prerequisites, record the plan and scope in BUILD_PLAN.md, then proceed. Implement the desktop shell/settings/importer and visual preview; add typed streaming conversation for each provider; add STT/TTS and robust audio/cancellation; integrate floating overlay states; implement memory/usage/privacy; integrate and verify local wake-word activation; then package and document. Validate each meaningful stage without repeatedly asking permission for routine reversible work.

Deliver source code, lockfile, runnable Windows output, README.md with exact commands, SETUP_WINDOWS.md for a non-specialist, CUSTOMIZATION.md, ARCHITECTURE.md, PRIVACY.md, TEST_REPORT.md, and CODEX_HANDOFF.md. Include an ignored development credentials example with no real keys and a visual asset manifest. Document voice/model changes, image replacement, floating-style settings, local data paths, startup/shutdown, and uninstall/data removal steps. Do not distribute my credentials or raw voice recordings.

The final report must say what works, what checks actually ran, what needs account credentials or my hardware, where to launch the app, and the next concrete action. Do not label placeholders production-ready. Do not omit features silently. Persist a checklist so the next Codex session can continue without rebuilding from scratch.

Begin now and carry the work through implementation and verification.

## END PROMPT

## Reference notes

The accompanying extraction file separates video observations from this proposed architecture. Current official references checked November 1, 2026:
- Anthropic Messages streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- OpenAI text generation/Responses: https://developers.openai.com/api/docs/guides/text
- OpenAI billing separation: https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform
- ElevenLabs realtime speech-to-text: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- ElevenLabs streaming TTS: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
- Electron BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron credential storage: https://www.electronjs.org/docs/latest/api/safe-storage
- Local wake-word candidate: https://github.com/dscripka/openWakeWord

This handoff has not been implemented or live-tested. Use the pack root execution guidance for phase ordering and the separate Codex build identity. The receiving Codex session must recheck API/package compatibility and account access while building.
