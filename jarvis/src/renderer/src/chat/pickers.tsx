import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/settings';
import type { AppSnapshot, ProviderId, SecretName, TtsModelInfo, VoiceInfo } from '../../../shared/types';
import type { ExternalLinkKey } from '../../../shared/endpoints';
import { call, errText, patchSettings } from '../hooks';
import { ActionButton, ExtLink, Meter, Pill } from './ui';

const LABEL: Record<SecretName, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', elevenlabs: 'ElevenLabs (voice)' };
const KEY_LINK: Record<SecretName, ExternalLinkKey> = { anthropic: 'anthropicKeys', openai: 'openaiKeys', elevenlabs: 'elevenlabsKeys' };

export function ConnectionPill({ snap, name }: { snap: AppSnapshot; name: SecretName }) {
  const c = snap.connections[name];
  const tone = c.state === 'ok' ? 'ok' : c.state === 'missing' ? 'muted' : c.state === 'untested' || c.state === 'testing' ? 'info' : 'bad';
  const text = { ok: 'Connected', missing: 'No key', untested: 'Not tested', testing: 'Testing…', auth_error: 'Key rejected', network_error: 'Cannot reach service', error: 'Error' }[c.state];
  return <Pill tone={tone}>{text}</Pill>;
}

/** Credential entry: the value goes to main once and is never read back; only masked status returns. */
export function KeyRow({ snap, name }: { snap: AppSnapshot; name: SecretName }) {
  const st = snap.secrets[name];
  const [value, setValue] = useState('');
  const [persist, setPersist] = useState(snap.encryptionAvailable);
  const c = snap.connections[name];
  return (
    <div className="keyrow">
      <div className="keyrow-head">
        <strong>{LABEL[name]}</strong>
        <ConnectionPill snap={snap} name={name} />
        {st.configured && <span className="masked">{st.masked} · {st.source === 'stored' ? 'saved (encrypted)' : st.source === 'session' ? 'this session only' : 'dev .env.local'}</span>}
        <span className="spacer" />
        <ExtLink k={KEY_LINK[name]}>Get a key</ExtLink>
      </div>
      <div className="keyrow-body">
        <input type="password" autoComplete="off" spellCheck={false} placeholder={st.configured ? 'Replace key…' : 'Paste API key'} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${LABEL[name]} API key`} />
        <label className="inline" title={snap.encryptionAvailable ? 'Encrypted with Windows (DPAPI) via Electron safeStorage' : 'OS encryption unavailable, so session-only entry is used'}>
          <input type="checkbox" checked={persist && snap.encryptionAvailable} disabled={!snap.encryptionAvailable} onChange={(e) => setPersist(e.target.checked)} />
          Save encrypted
        </label>
        <ActionButton
          kind="primary"
          disabled={value.trim().length < 10}
          onClick={async () => {
            await call('secrets:set', { name, value: value.trim(), persist: persist && snap.encryptionAvailable });
            setValue('');
          }}
        >
          Save
        </ActionButton>
        <ActionButton disabled={!st.configured} onClick={() => call('conn:test', { target: name })} title="Free: lists models/voices. Uses no tokens or characters.">
          Test (free)
        </ActionButton>
        {st.configured && st.source !== 'dev-env' && <ActionButton kind="danger" onClick={() => call('secrets:delete', { name })}>Remove</ActionButton>}
      </div>
      {c.detail && <small className={c.state === 'ok' ? 'okline' : 'err'}>{c.detail}</small>}
      {!snap.encryptionAvailable && <small className="err">OS encryption is unavailable, so keys are kept in memory for this session only (fail-closed).</small>}
    </div>
  );
}

export function ModelPicker({ provider, settings, snap }: { provider: ProviderId; settings: Settings; snap: AppSnapshot }) {
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const key = provider === 'anthropic' ? 'anthropicModel' : 'openaiModel';
  const current = settings.provider[key];
  const load = async () => {
    setErr('');
    try {
      const ids = await call<string[]>('models:list', { provider });
      setModels(ids);
      if (!current && ids.length) {
        const pick = provider === 'anthropic' ? (ids.includes('claude-haiku-5-5') ? 'claude-haiku-5-5' : (ids.find((i) => i.includes('haiku')) ?? ids[0]!)) : (ids.find((i) => /^gpt-[\d.]+-mini$/.test(i)) ?? ids.find((i) => i.includes('mini')) ?? ids[0]!);
        await patchSettings({ provider: { [key]: pick } });
      }
    } catch (e) {
      setErr(errText(e));
    }
  };
  const configured = snap.secrets[provider].configured;
  const options = current && !models.includes(current) ? [current, ...models] : models;
  return (
    <div className="field">
      <label>{provider === 'anthropic' ? 'Claude model' : 'OpenAI model'}</label>
      <div className="control">
        <span className="row">
          <select value={current} onChange={(e) => void patchSettings({ provider: { [key]: e.target.value } })} disabled={!options.length}>
            {!current && <option value="">Not selected</option>}
            {options.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <ActionButton disabled={!configured} onClick={load} title="Free metadata request">Load available models</ActionButton>
        </span>
        <small>Pulled from your own account, so nothing is assumed. A low-latency model ({provider === 'anthropic' ? 'Haiku class' : 'a “mini” model'}) suits voice best.</small>
        {err && <small className="err">{err}</small>}
      </div>
    </div>
  );
}

export function VoicePicker({ settings, snap }: { settings: Settings; snap: AppSnapshot }) {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [models, setModels] = useState<TtsModelInfo[]>([]);
  const [pasted, setPasted] = useState('');
  const [msg, setMsg] = useState('');
  const configured = snap.secrets.elevenlabs.configured;
  const v = settings.voice;
  const voiceOptions = v.voiceId && !voices.some((x) => x.id === v.voiceId) ? [{ id: v.voiceId, name: v.voiceName || v.voiceId }, ...voices] : voices;
  const modelOptions = models.length ? models : [{ id: v.ttsModel, name: v.ttsModel, canUseStyle: false, canUseSpeakerBoost: false }];
  const cur = models.find((m) => m.id === v.ttsModel);
  return (
    <>
      <div className="field">
        <label>Voice</label>
        <div className="control">
          <span className="row">
            <select
              value={v.voiceId}
              onChange={(e) => {
                const sel = voiceOptions.find((x) => x.id === e.target.value);
                void patchSettings({ voice: { voiceId: e.target.value, voiceName: sel?.name ?? '' } });
              }}
            >
              {!v.voiceId && <option value="">Not selected</option>}
              {voiceOptions.map((x) => <option key={x.id} value={x.id}>{x.name}{'category' in x && x.category ? ` (${x.category})` : ''}</option>)}
            </select>
            <ActionButton disabled={!configured} onClick={async () => setVoices(await call<VoiceInfo[]>('voices:list'))} title="Free metadata request">Load my voices</ActionButton>
          </span>
          <span className="row">
            <input type="text" placeholder="…or paste a voice ID you are authorised to use" value={pasted} onChange={(e) => setPasted(e.target.value.trim())} />
            <ActionButton
              disabled={!configured || !/^[A-Za-z0-9]{8,40}$/.test(pasted)}
              onClick={async () => {
                const info = await call<VoiceInfo>('voices:validate', { voiceId: pasted });
                await patchSettings({ voice: { voiceId: info.id, voiceName: info.name } });
                setMsg(`Imported “${info.name}”.`);
                setPasted('');
              }}
            >
              Validate & use
            </ActionButton>
          </span>
          <small>No voice cloning in this app. Create or pick a voice you're authorised to use in ElevenLabs, then select it here. Changes apply from the next reply.</small>
          {msg && <small className="okline">{msg}</small>}
        </div>
      </div>
      <div className="field">
        <label>Voice model</label>
        <div className="control">
          <span className="row">
            <select value={v.ttsModel} onChange={(e) => void patchSettings({ voice: { ttsModel: e.target.value } })}>
              {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === 'eleven_flash_v2_5' ? ' (low latency, default)' : ''}</option>)}
            </select>
            <ActionButton disabled={!configured} onClick={async () => setModels(await call<TtsModelInfo[]>('tts:models'))} title="Free metadata request">Load models</ActionButton>
          </span>
          <small>
            {cur ? `Supports style: ${cur.canUseStyle ? 'yes' : 'no'} · speaker boost: ${cur.canUseSpeakerBoost ? 'yes' : 'no'}. Unsupported settings are not sent.` : 'Load models to check which voice settings this model supports. Until then, style and speaker boost are not sent.'}
          </small>
        </div>
      </div>
    </>
  );
}

export function useDevices(kind: 'audioinput' | 'audiooutput'): MediaDeviceInfo[] {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then((d) => setList(d.filter((x) => x.kind === kind))).catch(() => setList([]));
    void load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, [kind]);
  return list;
}

export function AudioDevices({ settings, snap }: { settings: Settings; snap: AppSnapshot }) {
  const inputs = useDevices('audioinput');
  const outputs = useDevices('audiooutput');
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  const [testing, setTesting] = useState(false);
  useEffect(() => window.jarvis.on('levels', (l) => setLevels(l as { input: number; output: number })), []);
  useEffect(() => () => void call('audio:levelTest', { active: false }), []);
  const label = (d: MediaDeviceInfo, i: number) => d.label || `Device ${i + 1} (name shown after mic permission)`;
  return (
    <>
      <div className="field">
        <label>Microphone</label>
        <div className="control">
          <select value={settings.audio.inputDeviceId} onChange={(e) => void patchSettings({ audio: { inputDeviceId: e.target.value } })}>
            <option value="">System default</option>
            {inputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
          <span className="row">
            <button
              className="secondary"
              disabled={snap.muted}
              onClick={async () => {
                const next = !testing;
                setTesting(next);
                try {
                  await call('audio:levelTest', { active: next });
                } catch (e) {
                  setTesting(false);
                  alert(errText(e));
                }
              }}
            >
              {testing ? 'Stop mic test' : 'Test microphone (local, free)'}
            </button>
            <Meter value={Math.min(1, levels.input * 6)} label="Microphone level" />
          </span>
          <small>Mic tests stay on this computer. Nothing is sent to any service. The test turns itself off after 60 s.</small>
          {snap.micPermission === 'denied' && <small className="err">Microphone access is blocked. Allow it in Windows Settings → Privacy &amp; security → Microphone → “Let desktop apps access your microphone”.</small>}
        </div>
      </div>
      <div className="field">
        <label>Output</label>
        <div className="control">
          <select value={settings.audio.outputDeviceId} onChange={(e) => void patchSettings({ audio: { outputDeviceId: e.target.value } })}>
            <option value="">System default</option>
            {outputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
          <span className="row">
            <button className="secondary" onClick={() => void call('audio:testTone')}>Play test tone (local, free)</button>
          </span>
          <small>If your output isn't listed or can't be selected, use System default and pick the device in Windows Settings → System → Sound.</small>
        </div>
      </div>
    </>
  );
}
