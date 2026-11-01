# Windows setup

1. For everyday use, run `release/Jarvis-Codex-0.1.1-setup.exe` once, then open **Jarvis Codex** from its desktop or Start menu shortcut. It installs for your Windows account at `%LOCALAPPDATA%\Programs\Jarvis Codex\`. The portable build is also available in `release`; its first launch extracts the app before opening. No administrator rights are requested by the app. The package is unsigned; organizational/SmartScreen policy may require review. Do not disable Windows security.
2. Quit the other Jarvis/Claude build before testing speakers, microphone or wake detection. This build keeps a separate identity and data folder.
3. Open **Connections**. Enter an Anthropic API key for Claude, or an OpenAI API key for the alternate. Enter an ElevenLabs API key for voice. Click a key field and use **Ctrl+V** or **right-click → Paste**, then **Save key**. Text fields throughout the app support native editing; **Alt+E** opens the Edit menu. Keys stay masked. These are separate paid API accounts; chat/coding subscriptions are not assumed to provide them. Keys are entered locally, never in this chat.
4. Leave “Protect on this Windows account” checked for encrypted storage. Uncheck it for session-only storage. If Windows encryption is unavailable, persistence is refused; session-only remains available. The key input is cleared after submission and never included in snapshots or exports.
5. **Test connection / load catalog** separately for each configured provider. Select an account model, an ElevenLabs voice (or enter your permitted voice ID), and a supported speech model. Save settings. Catalog success does not prove a model/voice request will succeed. Failures remain visible; no provider changes automatically.
6. In **Audio**, refresh devices and choose the input/output. Save. **Test microphone locally (10s)** checks the level without upload. It requests audio only. Stop ends the test. Device names may remain hidden until permission is granted; refresh afterward.
7. In Connections, play the clearly labeled **short paid voice preview**. Then send one typed question and complete one Talk turn. Talk sends active command audio to ElevenLabs. Silence ends the utterance; Finish & send ends it manually. Hold to talk uses pointer/keyboard hold; the global shortcut toggles start/finish because Electron globalShortcut has no key-up callback.
8. Press Stop during a reply. Confirm immediate silence and no old speech resumes. Run the remaining live acceptance checks in TEST_REPORT.md before calling setup verified.

Default global shortcuts: Ctrl+Shift+Space for talk/finish and Ctrl+Shift+Backspace for Stop. Both can be changed. A collision is shown in Audio. The tray always offers Talk, Stop, mute, settings, show character and Quit. The app never automatically un-mutes after Windows lock or sleep.

Half-duplex is the default and only enabled conversational audio mode. The microphone is released during playback; use Talk to interrupt first. Hands-free spoken barge-in is not verified or enabled. Echo cancellation reduces feedback but is not a guarantee.

## ElevenLabs CLI onboarding

The official CLI saves the project credential to the gitignored `.env.local`; the installed desktop app uses its encrypted Windows vault instead. To connect that authorized project key without copying it, run `node --env-file=.env.local scripts/elevenlabs-onboard.mjs` from this folder. The utility uses the official SDK for read-only catalog/subscription checks, then encrypts the key into the Jarvis vault and retains an encrypted backup of the prior credential. It never starts Jarvis or generates audio. Quit and reopen Jarvis to load the new key. Use `--check-only` for a read-only check. Never display the env file or put its contents in chat.

November 1 diagnosis: the previous desktop key was rejected with `missing_permissions`; the new authorized key was validated and saved encrypted. The account reported `past_due` with open invoices and 90,000 unused credits. The saved voice ID returned HTTP 400 `voice_not_found`; reload the catalog and choose a real voice before previewing. No paid speech test was performed. Billing remediation must be done by the account owner.

## Optional local wake word setup

Read `wake/README.md`. A source-local runtime was installed and checked with synthetic silence; this does not prove real “Hey Jarvis” detection. Portable/installer builds do not bundle Python or the noncommercial pretrained models. Install the optional runtime into the isolated user-data wake folder, restart, then arm it explicitly. Wake mode never starts at launch. Default follow-up timeout is 0 (off); a nonzero setting explicitly opens a brief cloud listening window after a reply.

## Local data and removal

Normal data: `%APPDATA%\Jarvis Codex\`. This contains encrypted credential files, settings, copied character image, explicit memories, optional plaintext history and overlay position. Source tests use separate workspace `test-results/profile-*` folders with fake values only. Development and packaged Codex builds share the Codex data folder, never the Claude build's folder.

Close chat to keep the tray companion. Use **Quit Jarvis Codex** to end processes and capture. Remove individual credentials in Connections and memories in Memory. New conversation deletes local history after confirmation. To remove all local app data, quit first, then delete only the `Jarvis Codex` folder through File Explorer. Uninstall through Windows Apps for the installer; remove the portable executable for portable use. Removing local credentials does not revoke their provider-side keys.

## Prerequisites and recovery

For source builds use [Node.js](https://nodejs.org/en/download) and optionally [Git](https://git-scm.com/download/win). No .NET SDK, GPU, Docker, Ollama, or local conversation model is required. [Python for Windows](https://www.python.org/downloads/windows/) is needed only for optional wake setup; Python 3.12 was tested here.

If mic permission is denied, check Windows Settings → Privacy & security → Microphone, then activate Talk again. If an input disappears, choose a replacement explicitly; the app will not switch. Select Windows default output if per-app output selection is unavailable. If speech fails, the answer stays visible as text. Copy/type your question and retry explicitly; no automatic billable retry occurs. New conversation resets session usage counters, not provider billing.
