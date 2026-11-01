# Privacy

## What leaves your computer, and when

| Data | Goes to | When |
|---|---|---|
| Your typed messages and the bounded conversation context, plus saved memories (if "Send saved memories" is on) | The **selected** LLM provider only (Anthropic or OpenAI) | Each turn. Never both, unless you turn on cross-provider fallback (off by default) |
| Microphone audio | ElevenLabs speech-to-text | **Only while Jarvis is listening**: after you press Talk or the hotkey, after the local wake word fires, and during the optional follow-up window (default 6 s; set it to 0 to disable) |
| Reply text (speech-sized chunks) | ElevenLabs text-to-speech | When voice is on |
| API key validity checks, model and voice lists | The respective provider | When you press **Test** / **Load** |

- **Hands-free idle listening is local.** While armed, audio goes only to the wake-word helper on your PC. Tests verify that no speech-to-text session exists and no frames are sent to it in that state. Local wake detection does **not** make the whole system offline: once activated, your command audio and the conversation go to the cloud providers above.
- **Demo mode** sends nothing anywhere.
- OpenAI requests use `store: false`. Each provider's own retention and training policies apply. Jarvis can't verify or change them, so check each provider's terms.

## What is stored on your computer (`%APPDATA%\Jarvis\`)

| File | Contents | Protection |
|---|---|---|
| `credentials.enc.json` | API keys | Encrypted with Windows DPAPI through Electron safeStorage. If OS encryption is unavailable, keys are **not** saved (session-only). This protects keys at rest; it doesn't protect against other programs running as your Windows user |
| `settings.json` | Preferences (no secrets) | Plaintext |
| `memories.json` | Memories you explicitly saved | Plaintext |
| `history.json` | Conversation history, **only if you turn it on** (off by default) | Plaintext. Encrypting your keys does *not* encrypt history or memories |
| `usage.json` | Daily token, character, and second counters and setup-verification flags. No content | Plaintext |
| `assets\` | Your imported character image | Plaintext |
| `logs\jarvis.log` | Event and error codes, redacted. No conversation text, transcripts, or audio | Plaintext, capped at about 1 MB |

- **Raw audio is never written to disk.** Up to `preRollMs` (default 600 ms) of recent audio is held in RAM so the wake-word command isn't clipped, and is discarded continuously.
- The conversation lives in RAM by default and disappears when you quit, unless you turn on saved history.
- There's no telemetry, analytics, or crash upload. Diagnostics export only on your click, and include conversation text only if you tick that box.

## Deleting data

- **Memories:** Memory tab → Forget (per item) or Forget all (with confirmation).
- **History:** Memory tab → Delete saved history & clear session (with confirmation).
- **Keys:** Setup → Remove.
- **Everything:** quit Jarvis, then delete `%APPDATA%\Jarvis`.
