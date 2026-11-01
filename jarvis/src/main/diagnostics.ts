import { app } from 'electron';
import type { AppSnapshot } from '../shared/types';
import type { Settings } from '../shared/settings';
import type { LogEntry } from './log';
import type { UsageSnapshot } from '../shared/types';

/** Diagnostics export: versions, non-secret settings, statuses, error codes. No keys, no conversation unless opted in. */
export function buildDiagnostics(opts: {
  snapshot: AppSnapshot;
  settings: Settings;
  usage: UsageSnapshot;
  log: LogEntry[];
  wakeDropped: number;
  includeConversation: boolean;
}) {
  const { snapshot: s, settings } = opts;
  return {
    generatedAt: new Date().toISOString(),
    app: { name: app.getName(), version: s.version, packaged: app.isPackaged },
    runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, osRelease: process.getSystemVersion() },
    state: { conv: s.state, muted: s.muted, armed: s.armed, micActive: s.micActive, micPermission: s.micPermission, demoMode: s.demoMode },
    providers: {
      active: settings.provider.active,
      anthropicModel: settings.provider.anthropicModel,
      openaiModel: settings.provider.openaiModel,
      fallbackEnabled: settings.provider.fallbackEnabled,
      configured: { anthropic: s.secrets.anthropic.configured, openai: s.secrets.openai.configured, elevenlabs: s.secrets.elevenlabs.configured },
      credentialSource: { anthropic: s.secrets.anthropic.source, openai: s.secrets.openai.source, elevenlabs: s.secrets.elevenlabs.source },
      connections: Object.fromEntries(Object.entries(s.connections).map(([k, v]) => [k, { state: v.state, checkedAt: v.checkedAt }])),
    },
    voice: { ttsModel: settings.voice.ttsModel, sttModel: settings.voice.sttModel, outputFormat: settings.voice.outputFormat, voiceSelected: !!settings.voice.voiceId },
    activation: { mode: settings.activation.mode, duplex: settings.activation.duplex, shortcuts: s.shortcuts, wake: s.wake, wakeFramesDropped: opts.wakeDropped },
    overlay: { visibility: settings.overlay.visibility, alwaysOnTop: settings.overlay.alwaysOnTop, scale: settings.overlay.scale, shown: s.overlayShown },
    encryptionAvailable: s.encryptionAvailable,
    verification: s.verification,
    usage: { session: opts.usage.session, today: opts.usage.today, latency: opts.usage.latency, note: 'App counters/estimates only; not provider billing.' },
    recentEvents: opts.log.slice(-60),
    conversation: opts.includeConversation ? s.messages.map((m) => ({ role: m.role, text: m.text, at: new Date(m.createdAt).toISOString(), interrupted: m.interrupted })) : 'omitted (not opted in)',
  };
}
