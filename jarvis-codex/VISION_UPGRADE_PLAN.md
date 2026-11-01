# Phase 2 plan — held at real voice baseline gate

The Phase 2 specification was read before implementation. No camera/display capture code, permission grants, image uploads or misleading controls were added. A working **real** Phase 1 conversation + interruption baseline has not been recorded because the user chose to configure credentials in the application later. Fixture passes cannot satisfy that gate.

Current checkpoint: the Phase 1 source, exact lockfile, test evidence and Windows build outputs under `app/`. A source archive and hashes are recorded in CODEX_HANDOFF.md when packaging completes. No unrelated source or Claude project was inspected or modified.

After the user completes the required voice baseline:

1. Record both provider turns independently where configured, one complete ElevenLabs voice turn, Stop/late-chunk behavior, then the ten-turn and speaker/headphone results. Preserve the baseline checkpoint.
2. Add independently off-by-default camera and selected-window/display grants. Camera uses video-only; display capture has no audio. Bind native chooser selection to trusted frame, generation and expiring transaction. Never default to first display or substitute an unavailable source.
3. Extend canonical turns with short-lived typed VisualAttachment records. Use the existing controller, LLM cancellation and speech queue. Each attachment records source generation, time, dimensions and crop/mask metadata; image bytes remain only in RAM.
4. Implement local preview → processed-image review → explicit ask-and-look grant, with per-image review option. Crop/mask pixels before upload. Require new acknowledgment on provider/source changes. Update personality/capability flags only at this stage.
5. Add the one-in-flight shared scheduler: direct question priority, bounded latest pending frame, rate/timeout guards, conservative 10-second / six-per-minute / two-minute periodic defaults, local scene-change checks and optional spoken commentary separately enabled.
6. Add Stop all capture to visible UI, tray and hotkey; stop/invalidate on lock/resume, source removal and hidden indicator. Never add mouse/keyboard automation.
7. Prove transmitted fixture pixels, stale-frame rejection, source grant revocation, prompt-injection boundaries and voice regressions. Only then test the user-enabled real camera/window.

The original complete `specs/02_VISION_UPGRADE_SPEC.md` remains the acceptance source. This plan is not an implemented vision upgrade.
