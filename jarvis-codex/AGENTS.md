# Jarvis Codex project instructions

This folder is a build handoff containing specifications and an original character asset. The application is not implemented yet. Build application source in `app/` without rewriting these input specs to make failed requirements disappear.

Read `README_START_HERE.md`, `CODEX_START_PROMPT.txt`, and both files in `specs/` before implementation. Follow the complete Phase 1 requirements first, then apply Phase 2 after the required voice baseline. Phase 2 overrides only application-specific prohibitions on camera/screen vision. Preserve other requirements, environment rules, and user controls. Do not add computer control.

Codex is the builder; Claude/OpenAI are the application's runtime providers and ElevenLabs handles speech. Use the supplied PNG. Do not call image generation services or invent an asset dependency.

Keep this project isolated from the concurrent Claude Code version. Use the `Jarvis Codex` development/build identity, separate user data, locks and service ports. Do not read or modify Claude's project. Preserve unrelated user changes and never commit credentials.

Follow the host's credential provisioning rules before API-backed implementation or live calls when applicable. Never print or request plaintext keys in shared chat. A missing credential or microphone is not a passed integration test. Record blocked checks accurately.

Verify meaningful behavior with fixtures and supported build checks. Reserve real device tests for user-enabled sources on the target computer. Do not automatically enable capture. Keep fixture/live results separate. Record progress in `BUILD_PLAN.md` and final status in `CODEX_HANDOFF.md`. Do not buy, publish, deploy, or add unrelated business integrations.
