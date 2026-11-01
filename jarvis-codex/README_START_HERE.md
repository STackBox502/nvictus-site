# Jarvis — Codex build pack

Prepared for Chris Conley • November 1, 2026

This ZIP contains build instructions and the original character asset. It is not a finished application, installer, or a copy of the video's proprietary source. No API keys, credentials, recordings, or captured screens are included.

## Start

1. Extract this entire ZIP into its own folder, such as `Documents\Jarvis-Codex`. Keep it separate from the folder Claude is using.
2. Open the extracted folder as a project in Codex.
3. Paste the full contents of `CODEX_START_PROMPT.txt` into the Codex conversation.
4. Let Codex inspect prerequisites and build Phase 1 in `app/`, using `specs/01_VOICE_COMPANION_SPEC.md` and `assets/jarvis-character.png`.
5. Codex should implement Phase 2 in sequence after the required voice baseline passes. It must report any credential/hardware checks it cannot perform and must not claim fixture tests are live tests.
6. Supply credentials through Codex's secure supported setup flow or the app's local setup when requested. Never paste API keys into a shared prompt, repository, or screenshot.

If your Codex environment accepts a ZIP attachment, you can attach the ZIP and the starter prompt directly. If it cannot extract attachments into the project, use the local folder method above. A Windows desktop build and hardware checks require a suitable Windows environment. Cloud-only sessions may complete code and fixture checks but cannot prove your local overlay/camera/microphone works.

## Build order

| Phase | Result | Specification |
|---|---|---|
| 1 | Voice companion; Claude default, OpenAI alternate, ElevenLabs hearing/speaking, original floating character, memory and settings | `specs/01_VOICE_COMPANION_SPEC.md` |
| 2 | Optional camera and selected-window/display vision with explicit controls | `specs/02_VISION_UPGRADE_SPEC.md` |

Read Phase 2 during planning so the architecture can support it, but keep visual capture unavailable during the Phase 1 baseline. After that baseline, Phase 2 intentionally replaces the application's no-camera/no-screen rules where required. It does not add mouse/keyboard automation or external account integrations.

Codex is the builder. Claude and OpenAI remain the selectable runtime brains. Changing the builder does not change the requested application stack.

## Run alongside the Claude build

- Separate folders and separate app data. Codex writes only its own project and must not inspect or change Claude's working folder without a later instruction.
- Distinguishable development app/build name: `Jarvis Codex`. The spoken assistant name stays Jarvis. Keep credentials, memory, output artifacts, single-instance locks, and local service ports separate.
- Build concurrently; perform speaker, microphone, wake-word, and camera tests one app at a time. Quit the other app completely before live audio tests to avoid duplicate capture or the assistants responding to each other.
- Judge both builds using `BUILD_AND_COMPARISON_CHECKLIST.md`. Do not count a feature as finished because one builder reports success without evidence.

## Included files

- `CODEX_START_PROMPT.txt` — paste into Codex.
- `AGENTS.md` — project execution guidance.
- `specs/01_VOICE_COMPANION_SPEC.md` — complete voice requirements, adapted for Codex.
- `specs/02_VISION_UPGRADE_SPEC.md` — camera/screen extension.
- `reference/VIDEO_FINDINGS.md` — public video observations and source links.
- `assets/jarvis-character.png` — original generated character.
- `assets/ASSET_NOTES.md` — asset use and limitations.
- `BUILD_AND_COMPARISON_CHECKLIST.md` — completion and side-by-side evidence.
- `MANIFEST.json` — file sizes and SHA-256 checksums for package files, excluding the manifest itself.

## What Codex should deliver

Working source and lockfile under `app/`, a Windows build when supported, setup/customization/privacy/architecture documentation, meaningful verification results, and `CODEX_HANDOFF.md` with completed versus unverified requirements. It should record exact blockers and next actions instead of fabricating success. The pack itself has been checked for archive integrity and required files; no Jarvis runtime has been implemented or live-tested by packaging it.
