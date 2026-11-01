import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/settings';
import type { AppSnapshot, DisplayInfo } from '../../../shared/types';
import { call, patchSettings } from '../hooks';
import { AudioDevices, ModelPicker, VoicePicker } from './pickers';
import { Card, ConfirmButton, FieldRow, type Field } from './ui';

const SECTIONS: Array<{ title: string; fields: Field[] }> = [
  {
    title: 'Brain (LLM)',
    fields: [
      { path: 'provider.active', kind: 'select', label: 'Active provider', options: [['anthropic', 'Claude (Anthropic)'], ['openai', 'OpenAI']] },
      { path: 'provider.maxOutputTokens', kind: 'number', min: 64, max: 4096, step: 16, label: 'Max reply length', unit: ' tokens' },
      { path: 'provider.requestTimeoutMs', kind: 'number', min: 5000, max: 120000, step: 1000, label: 'Response timeout', unit: ' ms' },
      { path: 'provider.openaiReasoningEffort', kind: 'select', label: 'OpenAI reasoning effort', options: [['unset', 'Not sent (model default)'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium']], help: 'Only for OpenAI reasoning models. Other models reject this parameter.' },
      { path: 'provider.fallbackEnabled', kind: 'toggle', label: 'Cross-provider fallback', help: 'Off by default. When on, an outage on one provider sends that turn and its context to the other provider.' },
    ],
  },
  {
    title: 'Voice settings',
    fields: [
      { path: 'voice.enabled', kind: 'toggle', label: 'Speak replies', help: 'Off = text-only replies (no ElevenLabs characters used).' },
      { path: 'voice.stability', kind: 'range', min: 0, max: 1, step: 0.05, label: 'Stability' },
      { path: 'voice.similarityBoost', kind: 'range', min: 0, max: 1, step: 0.05, label: 'Similarity' },
      { path: 'voice.style', kind: 'range', min: 0, max: 1, step: 0.05, label: 'Style', help: 'Sent only if the selected voice model supports it.' },
      { path: 'voice.speed', kind: 'range', min: 0.7, max: 1.2, step: 0.05, label: 'Speed' },
      { path: 'voice.useSpeakerBoost', kind: 'toggle', label: 'Speaker boost', help: 'Sent only if the selected voice model supports it.' },
      { path: 'voice.outputFormat', kind: 'select', label: 'Audio quality', options: [['pcm_24000', 'PCM 24 kHz (default)'], ['pcm_22050', 'PCM 22.05 kHz'], ['pcm_16000', 'PCM 16 kHz (smallest)']] },
      { path: 'voice.languageCode', kind: 'text', label: 'Language code', placeholder: 'blank = auto (e.g. en)', max: 10 },
      { path: 'voice.sttModel', kind: 'text', label: 'Speech-to-text model', max: 60, help: 'Default scribe_v2_realtime (ElevenLabs realtime Scribe).' },
    ],
  },
  {
    title: 'Activation & hotkeys',
    fields: [
      { path: 'activation.mode', kind: 'select', label: 'Activation', options: [['click', 'Click to talk'], ['push', 'Push to talk (hold button)'], ['handsfree', 'Hands-free wake word']] },
      { path: 'activation.talkShortcut', kind: 'text', label: 'Talk hotkey', max: 60, help: 'Electron accelerator, e.g. CommandOrControl+Shift+Space. A fallback is tried if it is taken.' },
      { path: 'activation.stopShortcut', kind: 'text', label: 'Stop hotkey', max: 60 },
      { path: 'activation.duplex', kind: 'select', label: 'Turn-taking', options: [['half', 'Half-duplex (reliable: no listening while speaking)'], ['wakeBargeIn', 'Wake-word barge-in (experimental)']], help: 'Barge-in lets “Hey Jarvis” interrupt speech. Unverified on speakers; keep half-duplex if it hears itself.' },
      { path: 'activation.wakeThreshold', kind: 'range', min: 0.1, max: 0.95, step: 0.05, label: 'Wake sensitivity threshold', help: 'Higher = fewer false activations, may miss quiet speech.' },
      { path: 'activation.refractoryMs', kind: 'number', min: 0, max: 5000, step: 100, label: 'Wake refractory after speech', unit: ' ms' },
      { path: 'activation.followUpWindowMs', kind: 'number', min: 0, max: 30000, step: 500, label: 'Follow-up window', unit: ' ms', help: 'Hands-free only: after a reply, listen for a follow-up without the wake word (cloud STT) for this long. 0 = off.' },
      { path: 'activation.wakeCue', kind: 'toggle', label: 'Play a cue on wake' },
    ],
  },
  {
    title: 'Endpointing (when your turn ends)',
    fields: [
      { path: 'activation.vadSilenceSecs', kind: 'range', min: 0.3, max: 3, step: 0.1, label: 'Server silence to commit a segment', unit: ' s' },
      { path: 'activation.endpointMs', kind: 'number', min: 400, max: 4000, step: 100, label: 'Extra quiet time before sending', unit: ' ms' },
      { path: 'activation.noSpeechTimeoutMs', kind: 'number', min: 3000, max: 30000, step: 500, label: 'Give up if no speech', unit: ' ms' },
      { path: 'activation.maxUtteranceMs', kind: 'number', min: 5000, max: 120000, step: 1000, label: 'Max utterance length', unit: ' ms' },
      { path: 'activation.preRollMs', kind: 'number', min: 0, max: 1500, step: 100, label: 'Wake pre-roll kept (RAM only)', unit: ' ms' },
    ],
  },
  {
    title: 'Audio processing & output',
    fields: [
      { path: 'audio.echoCancellation', kind: 'toggle', label: 'Echo cancellation', help: 'Helps, but cannot guarantee the mic never hears the speakers.' },
      { path: 'audio.noiseSuppression', kind: 'toggle', label: 'Noise suppression' },
      { path: 'audio.autoGainControl', kind: 'toggle', label: 'Auto gain' },
      { path: 'audio.outputVolume', kind: 'range', min: 0, max: 1, step: 0.05, label: 'Voice volume' },
    ],
  },
  {
    title: 'Character & motion',
    fields: [
      { path: 'motion.preset', kind: 'select', label: 'Preset', options: [['orbit', 'Orbit'], ['drift', 'Drift'], ['still', 'Still']] },
      { path: 'motion.speed', kind: 'range', min: 0.25, max: 2, step: 0.05, label: 'Speed' },
      { path: 'motion.amplitude', kind: 'range', min: 0, max: 14, step: 0.5, label: 'Float amplitude', unit: ' px' },
      { path: 'motion.tilt', kind: 'range', min: 0, max: 2, step: 0.1, label: 'Max tilt', unit: '°' },
      { path: 'motion.glow', kind: 'range', min: 0, max: 1, step: 0.05, label: 'Glow intensity' },
      { path: 'motion.showOrbits', kind: 'toggle', label: 'Energy trails' },
      { path: 'motion.accentGold', kind: 'color', label: 'Gold accent' },
      { path: 'motion.accentViolet', kind: 'color', label: 'Violet accent' },
      { path: 'motion.reducedMotion', kind: 'select', label: 'Reduced motion', options: [['system', 'Follow Windows setting'], ['on', 'Always reduce'], ['off', 'Full motion']] },
    ],
  },
  {
    title: 'Overlay window',
    fields: [
      { path: 'overlay.visibility', kind: 'select', label: 'Visibility', options: [['onDemand', 'On demand (badge when idle)'], ['always', 'Always visible'], ['hidden', 'Hidden (tray only)']] },
      { path: 'overlay.alwaysOnTop', kind: 'toggle', label: 'Always on top', help: 'May not appear above exclusive full-screen games or video.' },
      { path: 'overlay.dock', kind: 'select', label: 'Dock side', options: [['right', 'Right'], ['left', 'Left']] },
      { path: 'overlay.scale', kind: 'range', min: 0.5, max: 2, step: 0.05, label: 'Size' },
      { path: 'overlay.opacity', kind: 'range', min: 0.3, max: 1, step: 0.05, label: 'Opacity' },
      { path: 'overlay.collapseDelayMs', kind: 'number', min: 1000, max: 60000, step: 500, label: 'Collapse to badge after', unit: ' ms' },
    ],
  },
  {
    title: 'Personality',
    fields: [
      { path: 'personality.assistantName', kind: 'text', label: 'Assistant name', max: 40, help: 'Display name only. A different wake phrase needs its own wake-word model.' },
      { path: 'personality.ownerName', kind: 'text', label: 'Address me as', max: 40 },
      { path: 'personality.replyLength', kind: 'select', label: 'Reply length', options: [['brief', 'Brief'], ['normal', 'Normal'], ['detailed', 'Detailed']] },
      { path: 'personality.humor', kind: 'select', label: 'Humor', options: [['off', 'Off'], ['light', 'Light'], ['dry', 'Dry, restrained']] },
      { path: 'personality.systemPrompt', kind: 'textarea', rows: 8, max: 8000, label: 'System instruction' },
      { path: 'personality.customInstructions', kind: 'textarea', rows: 3, max: 4000, label: 'Custom instructions' },
    ],
  },
  {
    title: 'Memory & privacy',
    fields: [
      { path: 'memory.persistHistory', kind: 'toggle', label: 'Save conversation history', help: 'Off by default. When on, history is stored as plain JSON in your Jarvis data folder (not encrypted).' },
      { path: 'memory.includeMemories', kind: 'toggle', label: 'Send saved memories as context' },
      { path: 'memory.maxHistoryMessages', kind: 'number', min: 2, max: 100, step: 1, label: 'Context: max messages' },
      { path: 'memory.maxContextChars', kind: 'number', min: 1000, max: 60000, step: 500, label: 'Context: max characters' },
    ],
  },
  {
    title: 'Usage limits (local guard)',
    fields: [
      { path: 'budget.maxTurnsPerSession', kind: 'number', min: 1, max: 1000, step: 1, label: 'Max turns per session' },
      { path: 'budget.maxOutputTokensPerDay', kind: 'number', min: 0, max: 10000000, step: 1000, label: 'Max output tokens / day', help: '0 = no limit. Estimate-based; providers report usage with delay. Not a billing cap.' },
      { path: 'budget.maxTtsCharsPerDay', kind: 'number', min: 0, max: 10000000, step: 1000, label: 'Max voice characters / day' },
      { path: 'budget.maxSttSecondsPerDay', kind: 'number', min: 0, max: 1000000, step: 60, label: 'Max listening seconds / day' },
      { path: 'budget.maxListenSessionMs', kind: 'number', min: 10000, max: 600000, step: 1000, label: 'Max continuous STT connection', unit: ' ms' },
    ],
  },
  {
    title: 'App',
    fields: [
      { path: 'app.closeToTray', kind: 'toggle', label: 'Closing the chat window keeps Jarvis in the tray', help: 'Use Quit (tray menu) to fully exit. Quit stops the mic, network calls, and helpers.' },
      { path: 'app.launchAtLogin', kind: 'toggle', label: 'Launch at Windows sign-in' },
    ],
  },
];

export function SettingsTab({ snap, settings }: { snap: AppSnapshot; settings: Settings }) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  useEffect(() => {
    void call<DisplayInfo[]>('displays:list').then(setDisplays);
  }, []);
  return (
    <div className="settings">
      <Card title="Models & voice">
        <ModelPicker provider="anthropic" settings={settings} snap={snap} />
        <ModelPicker provider="openai" settings={settings} snap={snap} />
        <VoicePicker settings={settings} snap={snap} />
      </Card>
      <Card title="Input & output devices">
        <AudioDevices settings={settings} snap={snap} />
      </Card>
      {SECTIONS.map((sec) => (
        <Card key={sec.title} title={sec.title}>
          {sec.fields.map((f) => <FieldRow key={f.path} field={f} settings={settings} />)}
          {sec.title === 'Overlay window' && (
            <>
              <div className="field">
                <label>Display</label>
                <div className="control">
                  <select value={settings.overlay.displayId ?? ''} onChange={(e) => void patchSettings({ overlay: { displayId: e.target.value ? Number(e.target.value) : null, position: null } })}>
                    <option value="">Primary display</option>
                    {displays.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                </div>
              </div>
              <span className="row">
                <button className="secondary" onClick={() => void call('overlay:resetPosition')}>Reset position</button>
                <button className="secondary" onClick={() => void call('overlay:setShown', { shown: !snap.overlayShown })}>{snap.overlayShown ? 'Hide character' : 'Show character'}</button>
              </span>
            </>
          )}
        </Card>
      ))}
      <Card title="Reset">
        <p className="muted">Restores every non-secret setting to its default. Your API keys, saved memories, character image, and history are left alone.</p>
        <ConfirmButton label="Reset settings to defaults" confirmLabel="Confirm reset" onConfirm={() => call('settings:reset', { confirm: true })} />
      </Card>
    </div>
  );
}
