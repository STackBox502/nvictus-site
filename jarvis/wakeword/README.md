# Jarvis wake-word helper (optional, local)

Hands-free "Hey Jarvis" runs **on your computer**: openWakeWord + ONNX in a small Python process. While Jarvis is armed, microphone audio goes only to this helper. Nothing goes to a cloud service until the wake word fires. Only the command after it goes to ElevenLabs.

- Protocol: length-prefixed 16 kHz PCM on stdin, whitelisted JSON lines on stdout (see `helper.py` docstring).
- No network at runtime. No shell. No file writes except the one-time `--download-models` step.
- Code license: openWakeWord is Apache-2.0. **The pre-trained `hey_jarvis` model is CC BY-NC-SA 4.0 (non-commercial).** Personal desktop use is fine. Don't bundle it into a commercial/client product.
- A different wake phrase needs a different compatible model (`--model-path your_model.onnx`). Changing the assistant's display name does not change the wake word.

Setup steps for Windows are in `../SETUP_WINDOWS.md` → *Hands-free (optional)*.
