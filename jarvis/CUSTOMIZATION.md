# Customizing Jarvis

Everything below is changed in the app. No code edits needed.

## Character image
- **Replace:** Setup → step 5 → **Import PNG / WebP…** (max 12 MB, 64–4096 px per side). The file is validated (signature, size, dimensions, decode), previewed on a checkerboard, then copied into `%APPDATA%\Jarvis\assets\`. Your original file is no longer needed.
- **Transparency:** an image without an alpha channel, or with opaque corners, gets a warning before you confirm.
- **Revert:** "Revert to placeholder" (with confirmation).
- Rendering is `object-fit: contain`, so aspect ratio and alpha are preserved. There's no backing panel.
- Per-state image overrides (a different image per state) aren't implemented in v1. Every state uses the master image with code-driven effects.

## Floating style (Settings → Character & motion)
| Setting | Range | Default |
|---|---|---|
| Preset | Orbit (vertical bob + tilt + two elliptical trails) · Drift (lateral sway + soft glow) · Still | Orbit |
| Speed | 0.25–2× (Orbit bob period = 5 s ÷ speed) | 1 |
| Float amplitude | 0–14 px | 8 px |
| Max tilt | 0–2° | 1.5° |
| Glow intensity | 0–1 | 0.6 |
| Energy trails | on/off | on |
| Gold / violet accent | any colour | #d4a64a / #8b5cf6 |
| Reduced motion | follow Windows · always · off | follow Windows |

Values are clamped so the character can't clip or flash. Listening glow follows **real mic level**, speaking glow follows **real played audio** (Web Audio analyser), and thinking is an orderly trail sweep. No lip-sync is attempted from a single image.

## Overlay (Settings → Overlay window)
Visibility (on-demand badge / always / hidden-to-tray), always-on-top, dock left/right, display, size (0.5–2×), opacity, collapse delay. Drag the ⠿ handle to move it. The position is remembered and clamped to the screen if a monitor is unplugged. Tray → **Reset character position** recovers it.

## Voice (Setup → step 3, Settings → Voice settings)
- **Choose a voice:** "Load my voices" lists voices on your ElevenLabs account, or paste a voice ID you're authorised to use and click "Validate & use". Changes apply from the next reply and never scramble a reply in progress.
- **Voice model:** default `eleven_flash_v2_5` (low latency). "Load models" shows which models support style and speaker boost. Unsupported settings aren't sent.
- **Stability, similarity, style, speed (0.7–1.2), speaker boost, audio quality (PCM 16/22.05/24 kHz), language code.**
- No voice cloning in the app. Create or approve voices in ElevenLabs.
- Suggested direction (editable, your choice): mature, warm lower register, precise and calm, dry understated humor, clear American English. Not a copy of any actor.

## Brain (Settings → Brain)
- Provider: Claude (default) or OpenAI. Models are loaded from **your** account. Nothing is hard-coded from a video.
- Max reply tokens, response timeout, OpenAI reasoning effort (only for reasoning models), cross-provider fallback (**off** by default, because it would send the turn to a second provider).
- Switching provider with an existing conversation shows a note that the context will go to the new provider. Start a new conversation to avoid that.

## Personality (Settings → Personality)
Assistant name, how it addresses you (default "Chris"), reply length, humor, the full system instruction (pre-filled with your brief's text), and custom instructions. A different assistant *name* doesn't change the wake word (that needs its own model).

## Wake word
- Default "Hey Jarvis" (openWakeWord). Threshold, refractory time, follow-up window, and cue sound are in Settings → Activation.
- A custom phrase needs a compatible openWakeWord `.onnx` model. Run the helper with `--model-path your_model.onnx` (support for selecting a custom model inside the app isn't built yet). Typing a new phrase can't train a model.

## Hotkeys
Settings → Activation: Talk (default Ctrl+Shift+Space) and Stop (default Ctrl+Shift+X), using Electron accelerator syntax. If one is taken, a fallback is tried (Ctrl+Alt+Space / Ctrl+Shift+J, Ctrl+Alt+X). The tray always works.

## Limits (Settings → Usage limits)
Turns per session, output tokens / day, voice characters / day, listening seconds / day, max continuous STT connection. This is a local, estimate-based stop. Set real spending caps in each provider's dashboard.

## Reset
Settings → Reset restores every non-secret setting. Keys, memories, history, and the character are kept.
