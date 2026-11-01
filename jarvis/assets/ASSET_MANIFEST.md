# Visual and model asset manifest

| Asset | Source | Shipped in the app? | License / notes |
|---|---|---|---|
| Character (falcon guardian PNG) | Supplied by the owner (AI-generated, original). Imported at runtime via Setup → step 5 | **No.** Copied to `%APPDATA%\Jarvis\assets\character.png|webp` with `manifest.json` (name, size, alpha, import time) | Owner's asset. Not committed to this repo |
| Placeholder character | `src/renderer/src/overlay/Placeholder.tsx` (inline SVG, drawn in code) | Yes | Original. Visibly labeled "PLACEHOLDER" |
| Tray and window icon | Drawn procedurally in `src/main/windows.ts` (`drawIcon`) | Yes (generated at runtime) | Original |
| Installer / `.exe` icon | Electron default (none configured) | Yes | Add `build/icon.ico` (256×256) to brand it |
| Energy trails, glow, motion | Code (SVG + CSS transforms) | Yes | Original. No generated video |
| Wake-word models (`hey_jarvis_v0.1.onnx`, melspectrogram, embedding) | Downloaded during optional hands-free setup by `helper.py --download-models` from the openWakeWord GitHub releases | **No.** Stored inside your `wakeword-venv` | **CC BY-NC-SA 4.0 (non-commercial).** Personal use only. Do not redistribute in a commercial product |
| Screenshots in `docs/screenshots/` | Automated smoke test (Demo mode, placeholder) | No | Contain no secrets or personal data |

The app doesn't generate images, video, or voices, and it doesn't call any image or video API.
