# Setting up Jarvis on Windows (step by step)

About 15 minutes. You don't need administrator rights for Jarvis itself.

## 1. Install the tools (one time)

1. **Node.js LTS** (version 22.12 or newer): https://nodejs.org/en/download. Run the installer with default options.
2. **Git** (optional, only if you want `git clone`): https://git-scm.com/downloads/win. You can download the repository as a ZIP from GitHub instead.

Check that Node installed. Open **Command Prompt** (Start → type `cmd`) and run:

```bat
node -v
```

You should see `v22.12` or newer.

## 2. Get the code and build the app

In Command Prompt, go to the `jarvis` folder of the repository (adjust the path to where you put it):

```bat
cd C:\path\to\nvictus-site\jarvis
```

Install the exact dependency versions:

```bat
npm ci
```

Build the portable app:

```bat
npm run package:win:portable
```

When it finishes, the app is at `release\Jarvis-0.1.0-portable.exe`. Double-click it to run. You can move this single file anywhere.

> The build is **not code-signed** (that needs a paid certificate). Because you built it on your own PC, Windows normally runs it without a SmartScreen prompt. If you copy the `.exe` to another PC through the internet, Windows may show a warning there.

Prefer running from source instead? `npm run dev` (development) or `npm run build` then `npm start`.

## 3. Allow the microphone (one time)

Windows Settings → **Privacy & security → Microphone**:

- **Microphone access**: On
- **Let desktop apps access your microphone**: On

Jarvis only asks for audio. It never asks for the camera or the screen.

## 4. First run: the Setup tab walks you through 7 steps

1. **Read the cost note.** Optionally turn on **Demo mode** to try everything with zero charges.
2. **Paste API keys.** One of Anthropic or OpenAI, plus ElevenLabs for voice. Click **Save**, then **Test (free)**. Tests only list models and voices, so they use no tokens or characters.
   - Anthropic keys: https://platform.claude.com/settings/keys
   - OpenAI keys: https://platform.openai.com/api-keys (OpenAI API billing is separate from ChatGPT)
   - ElevenLabs keys: https://elevenlabs.io/app/settings/api-keys
3. **Pick models and a voice.** Click **Load available models** and **Load my voices**. Jarvis suggests a low-latency model from *your* account. The voice preview is labeled because it uses about 50 ElevenLabs characters.
4. **Microphone and speakers.** Pick a microphone and click **Test microphone (local, free)**; the meter should move when you speak. Click **Play test tone** to check speakers.
5. **Character.** Click **Import PNG / WebP…** and choose your transparent falcon PNG. Jarvis warns you if the image has no transparency (otherwise you'd get a white box on the desktop). Try the motion presets and the **Visual preview**, which are free.
6. **How you talk.** Choose Click to talk, Push to talk, or Hands-free (see below).
7. **Verify.** Turn Demo mode off. Ask one short question, press **Stop** while it's speaking, then ask a follow-up. Both checkmarks turn green only from real, live audio.

## Everyday use

- **Talk:** the Talk button on the character or in the chat, or the hotkey **Ctrl + Shift + Space**. Press the hotkey once to start and again to send. Electron can't detect a hotkey being *held*, so true hold-to-talk works on the on-screen button.
- **Stop:** the Stop button, **Ctrl + Shift + X**, or say "stop" after pressing Talk.
- **Mute** turns the microphone fully off. **Hide** only hides the character; the tray icon keeps showing whether the mic is on.
- **Tray icon** (bottom-right, near the clock) has Talk, Stop, Mute, Show/Hide character, Reset character position, Settings, and **Quit**. Closing the chat window keeps Jarvis in the tray. Use Quit to fully exit.
- If a hotkey is already taken by another app, Jarvis tries a fallback and shows the status in Setup → step 6. The tray always works.

## Hands-free "Hey Jarvis" (optional)

The wake word is detected **on your PC** by a small Python helper, so idle room audio is never uploaded. Setup is one time.

1. Install **Python 3.12** from https://www.python.org/downloads/windows/ (default options; the `py` launcher is included).
2. Open Command Prompt in the repository's `jarvis\wakeword` folder:

   ```bat
   cd C:\path\to\nvictus-site\jarvis\wakeword
   ```

3. Create the helper's own environment in your Jarvis data folder:

   ```bat
   py -3.12 -m venv "%APPDATA%\Jarvis\wakeword-venv"
   ```

4. Install the pinned packages:

   ```bat
   "%APPDATA%\Jarvis\wakeword-venv\Scripts\python.exe" -m pip install --require-virtualenv -r requirements.txt
   ```

5. Download the wake-word model files (one time):

   ```bat
   "%APPDATA%\Jarvis\wakeword-venv\Scripts\python.exe" helper.py --download-models
   ```

6. Run the self-test. You should see `"ok": true` with a silence score near 0:

   ```bat
   "%APPDATA%\Jarvis\wakeword-venv\Scripts\python.exe" helper.py --self-test
   ```

7. In Jarvis: **Setup → step 6 → Hands-free**, then **Run local self-test**, then **Arm hands-free**. The character shows "Listening for wake word · local only".

Notes:

- The stock `hey_jarvis` model is licensed **non-commercial (CC BY-NC-SA 4.0)**. It's fine on your own desktop, but don't bundle it into a client product.
- After a reply, Jarvis listens for a follow-up for 6 seconds without the wake word (that audio *does* go to ElevenLabs). Set **Follow-up window** to 0 in Settings to turn this off.
- Keep **Turn-taking: Half-duplex** unless you've tested barge-in on your speakers. Headphones give the cleanest results.
- If the helper isn't installed, the Hands-free option stays disabled with a clear reason. Everything else keeps working.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Microphone permission was denied" | Step 3 above, then press Talk again |
| "Key rejected" | Re-paste the key; check it's an **API** key from the right console |
| "Insufficient credits or quota" | Add credits in that provider's billing page (links in Setup → step 2) |
| Text replies but no voice | Choose a voice in step 3; check ElevenLabs credits; the reply shows "Voice unavailable" with the reason |
| Jarvis answers itself | Use headphones, keep Half-duplex, lower speaker volume |
| Character is off-screen | Tray → **Reset character position** |
| Character not above a full-screen game or video | Exclusive full-screen apps can draw over all other windows. Use windowed or borderless mode |

## Removing Jarvis

Delete the portable `.exe` (or uninstall the installer build from Windows Settings → Apps). To remove keys, memories, history, settings, and the wake-word environment, delete the folder `%APPDATA%\Jarvis`.
