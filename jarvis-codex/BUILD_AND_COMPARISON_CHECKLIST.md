# Jarvis — build and comparison checklist

Updated November 1, 2026. Evidence is in app/TEST_REPORT.md and app/test-results. Fixture results are not live provider or hardware results. Claude comparison is untouched and unverified.

| Requirement | Codex fixture/build evidence | Codex live evidence | Claude live evidence |
|---|---|---|---|
| Clean setup, app launches, production package builds | PASS — Windows portable + NSIS build, packaged-smoke.json | PASS — packaged app opens; clean-machine installer UNVERIFIED | UNVERIFIED — no comparison performed |
| Claude text and voice turn | PASS — serializer + speech-controller fixtures | NOT CONFIGURED — enter API keys, select account model/voice | UNVERIFIED — no comparison performed |
| OpenAI text and voice turn | PASS — Responses schema/events + speech fixtures | NOT CONFIGURED — test this provider independently | UNVERIFIED — no comparison performed |
| Ten consecutive voice turns without duplication/overlap | PASS — ten controller speech fixtures; unit-tests.txt | UNVERIFIED — ten actual microphone/provider turns required | UNVERIFIED — no comparison performed |
| Stop cancels audio and late chunks never resume | PASS — generation, output-credit, interrupted-context tests | UNVERIFIED — physical Stop-to-silence and stale playback test | UNVERIFIED — no comparison performed |
| Push-to-talk, hotkey conflicts, tray recovery | PASS — early-release fixture and configured tray/shortcuts; external focus untested | UNVERIFIED — another app focused; collision/recovery test | UNVERIFIED — no comparison performed |
| Local wake-word behavior and idle cloud boundary | PASS — local idle routing fixture; real ONNX synthetic-silence protocol | UNVERIFIED — install optional runtime for package; phrase/false activation tests | UNVERIFIED — no comparison performed |
| Speaker feedback and interruption behavior | PASS — half-duplex lifecycle fixtures; no spoken barge-in | UNVERIFIED — real speakers and headphones separately | UNVERIFIED — no comparison performed |
| Floating PNG, Orbit/Drift/Still, reduced motion | PASS — UI/asset checks and inspected renders; current original PNG | UNVERIFIED — actual playback/input reactivity | UNVERIFIED — no comparison performed |
| Click-through, dragging, display/DPI changes | PASS — geometry clamp and off-screen recovery; Windows transparent document | UNVERIFIED — native clicks/drag and physical monitor/DPI transitions | UNVERIFIED — no comparison performed |
| Memory, opt-in history, deletion, context limits | PASS — CRUD, serial writes, reload/delete/context tests and UI save | PASS — local Windows UI save; real conversation context not yet tested | UNVERIFIED — no comparison performed |
| Credentials excluded from bundles/logs/exports | PASS — vault fixtures, Windows dummy-secret encryption, package-audit.json | NOT CONFIGURED — no real credentials entered during build | UNVERIFIED — no comparison performed |
| Failures leave typed chat and controls usable | PASS — missing config, fake permission, HTTP, incomplete stream and TTS fixtures | UNVERIFIED — real network/credit/device disruptions | UNVERIFIED — no comparison performed |
| Camera snapshot question and device release | NOT CONFIGURED — Phase 2 baseline gate | NOT CONFIGURED — no camera capture implemented | UNVERIFIED — no comparison performed |
| Selected-window capture without source fallback | NOT CONFIGURED — Phase 2 baseline gate | NOT CONFIGURED — no screen capture implemented | UNVERIFIED — no comparison performed |
| Crops/masks affect transmitted pixels | NOT CONFIGURED — Phase 2 baseline gate | NOT CONFIGURED | UNVERIFIED — no comparison performed |
| Camera and Screen off independently | NOT CONFIGURED — both capabilities absent | NOT CONFIGURED | UNVERIFIED — no comparison performed |
| Timed analysis limits and no requests when off | NOT CONFIGURED — no visual scheduler or uploads | NOT CONFIGURED | UNVERIFIED — no comparison performed |
| Provider/source changes reject stale visual results | NOT CONFIGURED — Phase 2 not implemented | NOT CONFIGURED | UNVERIFIED — no comparison performed |
| Stop all and lock/resume stop every capture stream | PASS — audio generation/cancel fixtures; visual capture absent | UNVERIFIED — physical lock/sleep/resume and device release | UNVERIFIED — no comparison performed |
| No mouse/keyboard control or unrelated permissions | PASS — narrow IPC, no tools, camera/display denial fixtures | PASS — local packaged capability boundary; no external actions tested | UNVERIFIED — no comparison performed |

## Comparable observations

Windows 10.0.26300 x64; Node 24.14.0/npm 11.9.0; Electron 45.2.1/Chromium 156.0.8078.75; React 19.3.1; Vite 8.3.5. Native fetch/ws transports, no provider SDK. Optional Python 3.12.10/openWakeWord 0.6.0/ONNX Runtime 1.31.1. No selected live model/voice or real headset/speaker samples. Artifact hashes and source checkpoint identify the build. No quality score or latency percentile is claimed.

Next: configure credentials locally, verify real conversation/interruption and ten turns one app at a time, then continue Phase 2. Source and fixture success do not establish a working live two-phase system.
