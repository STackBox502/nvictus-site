# Privacy and security

Microphone starts off after launch, restart, Windows lock/sleep and resume. Start Talk or explicitly arm local wake detection to activate it. Camera, screen capture, browser control, computer automation, external account tools and telemetry/crash uploads are not enabled in this build.

## Data flow

Activated microphone command audio goes to ElevenLabs Scribe realtime. Finalized transcript, bounded conversation and explicit saved memories go to the selected Claude or OpenAI API. Speech-enabled response text goes to ElevenLabs TTS. No alternate provider is used automatically. Deliberately switching the brain requires acknowledgment if chat context exists.

Optional wake listening processes 16 kHz mono PCM locally in a fixed Python/ONNX helper, with an 800 ms in-memory activation pre-roll. Ambient audio is not uploaded while armed. After activation, command audio is cloud-backed. A configured follow-up window explicitly continues command capture for a short bounded period; 0 disables it. Stop/Mute ends wake processing, microphone tracks, speech connections and playback.

Catalog refreshes contact the respective provider on your action. The visual preview uses neither devices nor providers. Provider terms and retention vary by account. There is no claim of zero provider retention, end-to-end confidentiality, or removal of provider logs when you delete local data. Canceling cannot recall bytes already sent or guarantee no charge.

## Storage

- Credentials: OS-backed asynchronous Electron safeStorage on Windows, in `%APPDATA%\Jarvis Codex\credentials`. If encryption is unavailable, persistence fails closed. Explicit session-only entry remains in main-process RAM. A key briefly exists in the local password input during setup, is sent over narrow IPC, cleared from the form, and is never returned to renderers. No automatic environment-secret loading occurs.
- Settings, copied character, overlay position and explicit saved memories: local plaintext files.
- Chat: RAM by default. Opted-in plaintext `history.json` is bounded to 200 messages. Turning persistence off deletes the saved file. New conversation clears current and persisted chat after confirmation. No raw audio is retained.
- Exports: user-chosen local JSON/Markdown. Diagnostic export excludes chat, memories, keys, device IDs and audio; it contains runtime versions, model IDs, masked credential status, counters, timing samples and safe statuses.
- Optional wake models/runtime: separate local `wake` folder; no cloud inference or microphone-owning helper.

Encrypted credentials do not encrypt chat or memories and do not protect against every program running as the same Windows user. Deleting local files does not guarantee forensic erasure or remove exports/backups you made.

## Application boundaries

Main owns fixed official provider endpoints and credentials. Renderer has no Node integration, generic file/network/shell API, or raw ipcRenderer. Context isolation, sandboxing, web security, strict CSP, local protocol path validation, validated command schemas and main-frame/sender checks are enabled. New windows/navigation/webviews are blocked. Audio permission is restricted to the trusted chat window during activation; camera/display permissions are denied. The renderer cannot fetch arbitrary URLs.

Memory is user data and cannot authorize tools. No LLM tools are attached. Local command matching is exact for controls; deletion redirects to confirmed UI operations. Errors omit raw provider bodies, authorization values and sensitive URLs. There are no live test credentials in source or packages.

Close-to-tray keeps the process and any explicitly armed microphone mode alive; the tray tooltip/menu and chat retain mic controls. Hide character does not mean mute. Quit stops capture, providers and the helper. The optional wake detector is never a second microphone owner.
