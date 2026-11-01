# Jarvis Codex build plan

Started November 1, 2026. User authorized implementation with credentials deferred to local application setup.

## Boundaries
- Dedicated `app/` under this pack; no changes to synced sources or Claude's project.
- Electron + TypeScript + React + Vite. Claude default, OpenAI selectable, ElevenLabs speech.
- Main-process networking/secrets, validated IPC, isolated Jarvis Codex user data, no runtime local server.
- No paid requests, device capture, account provisioning, publication, or image generation during this build.
- Phase 2 capture remains unimplemented until the required real voice baseline is recorded. Its extension contract and remaining work will be documented.

## Sequence
1. Verify official APIs, prerequisites, asset checksums and dependency versions.
2. Desktop shell, transparent companion, settings, secure local setup and preview.
3. Canonical streaming conversation, bounded context, interruption and durable memory.
4. ElevenLabs realtime PCM input, sentence-sized streaming PCM output, one capture/playback owner.
5. Local wake-word investigation, supported optional helper or explicit unavailable state.
6. Meaningful fixture tests, typecheck, lint, production build, Windows launch/UI checks and packaging.
7. Setup/customization/privacy/architecture docs, evidence checklist and exact remaining live checks.

## Prerequisites observed
- Windows; Node 24.14.0; npm 11.9.0; Git 2.53.0.windows.2; Python 3.12.10.
- No .NET SDK (not required). No OpenAI credential in process/project. No credentials will be searched for in unrelated locations.
- Sandbox npm DNS failed; approved network execution can reach registry. Electron stable registry version: 45.2.1.
- Runtime model/voice selection requires account catalog refresh and an explicit paid test; no account access is assumed.

## Evidence policy
Fixtures are not live integrations. Startup and screenshots do not prove hardware audio. Live microphone, speaker, wake-word and vision acceptance require user activation, one companion app at a time.

## Implementation outcome

- Phase 1 source, runtime integrations, UI, memory/security, optional wake helper and documentation implemented.
- 36 unit/transport/controller fixtures pass. 18 Windows UI checks pass; fake microphone only.
- Windows safeStorage was exercised with a dummy value. The optional ONNX helper loaded and processed silence offline.
- Unsigned portable and per-user installer build successfully; the packaged asar app launched with microphone off and no provider calls.
- Original asset and specs preserved. Editable source checkpoint and artifact checksums are under deliverables/release.
- Real account/model/voice/hardware acceptance is UNVERIFIED, as credentials were deferred by the user. This is the remaining Phase 1 baseline gate.
- Phase 2 capture implementation is held until that real baseline, with plan and explicit not-implemented reports saved.

See CODEX_HANDOFF.md and app/TEST_REPORT.md for exact evidence and remaining checks. The full requested two-phase application is not declared complete.
