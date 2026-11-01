# Optional local Hey Jarvis detector

openWakeWord **0.6.0** on Python **3.12.10**, using ONNX on Windows. The exact installed package versions are in `requirements.txt`; source artifacts and SHA-256 hashes are in `model-manifest.json`. No TFLite, local conversation model, GPU, or new paid account is required.

The source-local `.venv` and three ONNX artifacts were installed for this build. A strict-protocol test fed four seconds of zero PCM; the helper emitted READY, no WAKE, exited successfully, and emitted no stderr. This proves loadability/protocol behavior only. Actual keyword recognition, false activations, speaker feedback, accent handling and live command onset remain unverified.

## Install for the portable/installed application

Python and pretrained models are deliberately not included in the Windows executable. Use Python 3.12 on Windows and run from the delivered app source directory:

```powershell
python wake/setup.py --target "$env:APPDATA\Jarvis Codex\wake"
```

This explicit setup downloads pinned Python dependencies and three known ONNX artifacts to the isolated Jarvis Codex folder. It verifies the recorded model hashes. It makes no microphone or paid provider calls. Restart Jarvis after setup. The runtime is found in this user-data folder or, for source development, in source `wake/.venv`.

Configure the conversation provider and ElevenLabs first. Audio → Arm local wake word starts the helper and one microphone capture. The indicator says local only while armed. Detection opens Scribe only for command audio. Eight hundred milliseconds of RAM pre-roll is included to preserve command onset. Microphone is released during speech; wake resumes only after the configured refractory interval. Stop listening/Mute/Quit ends the helper and input. No arbitrary custom phrase training/import is exposed.

The helper takes only a fixed model folder and bounded threshold from main. Input is binary 16 kHz mono int16, 2,560-byte frames. Output is only READY, WAKE or ERROR lines. There is no HTTP listener, shell command protocol, or second microphone session. Main limits buffering and supervises startup/exit. Startup is allowed up to 45 seconds for cold Python imports.

## Licensing

[openWakeWord's code](https://github.com/dscripka/openWakeWord) is Apache 2.0. Its published pretrained keyword models are [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), attributed to David Scripka/openWakeWord. This personal companion build does not establish permission for commercial model redistribution or client deployment. The models are downloaded separately, not redistributed inside the executable. Use a suitably licensed model before commercial distribution. The static guardian asset is separate from these keyword models.
