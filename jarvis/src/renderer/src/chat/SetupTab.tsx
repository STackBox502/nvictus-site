import type { Settings } from '../../../shared/settings';
import type { AppSnapshot } from '../../../shared/types';
import { call, patchSettings, prettyAccel } from '../hooks';
import { CharacterImport } from './CharacterImport';
import { AudioDevices, KeyRow, ModelPicker, VoicePicker } from './pickers';
import { ActionButton, Card, ExtLink, FieldRow, Pill } from './ui';

export function SetupTab({ snap, settings, goChat }: { snap: AppSnapshot; settings: Settings; goChat: () => void }) {
  const llmReady = snap.providerConfigured.anthropic || snap.providerConfigured.openai;
  const voiceReady = snap.secrets.elevenlabs.configured && !!settings.voice.voiceId;
  const wake = snap.wake;
  return (
    <div className="setup">
      <Card step={1} title="How Jarvis works (and what costs money)">
        <p>
          <strong>Claude or OpenAI</strong> is the brain: it writes the replies. <strong>ElevenLabs</strong> is the ears and voice: it handles speech-to-text and text-to-speech. Each is billed separately by its provider on its own API account.
          A ChatGPT, Claude, or Claude Code subscription does <em>not</em> include API access. Live conversations use paid API calls.
        </p>
        <p>
          Free in this app: connection tests, model and voice lists, mic tests, test tones, character presets, the visual preview, and <strong>Demo mode</strong>. Paid: real conversations, plus the voice preview and voice test (both labelled).
        </p>
        <FieldRow settings={settings} field={{ path: 'demoMode', kind: 'toggle', label: 'Demo mode', help: 'Simulated brain, transcript, and placeholder tone. No network, no keys, no charges. Use it to try every control first.' }} />
      </Card>

      <Card step={2} title="Connect your accounts" status={llmReady ? <Pill tone="ok">Brain ready</Pill> : <Pill tone="warn">Add one LLM key</Pill>}>
        <p className="muted">Only one of Anthropic or OpenAI is needed to start. Keys go straight to the background process, are encrypted by Windows when saved, and are never shown again (only the last 4 characters).</p>
        <KeyRow snap={snap} name="anthropic" />
        <KeyRow snap={snap} name="openai" />
        <KeyRow snap={snap} name="elevenlabs" />
        <p className="muted">
          Billing: <ExtLink k="anthropicBilling">Anthropic</ExtLink> · <ExtLink k="openaiBilling">OpenAI</ExtLink> · <ExtLink k="elevenlabsUsage">ElevenLabs</ExtLink>
        </p>
      </Card>

      <Card step={3} title="Choose the brain and the voice">
        <FieldRow settings={settings} field={{ path: 'provider.active', kind: 'select', label: 'Default brain', options: [['anthropic', 'Claude (Anthropic)'], ['openai', 'OpenAI']] }} />
        <ModelPicker provider="anthropic" settings={settings} snap={snap} />
        <ModelPicker provider="openai" settings={settings} snap={snap} />
        <VoicePicker settings={settings} snap={snap} />
        <span className="row">
          <ActionButton disabled={!voiceReady && !snap.demoMode} onClick={() => call('voice:preview')} title="Uses roughly 50 ElevenLabs characters">
            Preview voice (uses ~50 ElevenLabs characters)
          </ActionButton>
        </span>
      </Card>

      <Card step={4} title="Microphone and speakers">
        <AudioDevices settings={settings} snap={snap} />
        <p className="muted">After the free mic test, the paid check is the voice preview in step 3, then one real conversation in step 7.</p>
      </Card>

      <Card step={5} title="Character and motion (no API calls)">
        <CharacterImport settings={settings} snap={snap} />
      </Card>

      <Card step={6} title="How you start talking">
        <FieldRow
          settings={settings}
          field={{
            path: 'activation.mode',
            kind: 'select',
            label: 'Activation',
            options: [
              ['click', 'Click to talk (click again or pause to send)'],
              ['push', 'Push to talk (hold the on-screen button)'],
              ['handsfree', 'Hands-free “Hey Jarvis” (local wake word)'],
            ],
          }}
        />
        <p className="muted">
          Global hotkey <kbd>{prettyAccel(snap.shortcuts.talk.accelerator)}</kbd> {snap.shortcuts.talk.registered ? <Pill tone="ok">registered</Pill> : <Pill tone="bad">taken by another app, use the tray</Pill>} works while other apps have focus.
          Electron hotkeys can't detect key release, so the hotkey is press to start and press again to send. True hold-to-talk works on the on-screen button.
        </p>
        {settings.activation.mode === 'handsfree' && (
          <div className="subcard">
            <p>
              Wake word: <Pill tone={wake.state === 'ready' ? 'ok' : wake.state === 'unavailable' || wake.state === 'error' ? 'bad' : 'info'}>{wake.state}</Pill> {wake.reason}
            </p>
            <p className="muted">
              “Hey Jarvis” is detected on this computer by openWakeWord. Idle room audio never goes to a cloud service. Only the command after the wake word is sent to ElevenLabs. It needs a one-time Python setup (see SETUP_WINDOWS.md → Hands-free).
              The stock “hey_jarvis” model is licensed for non-commercial use (CC BY-NC-SA 4.0). Fine for your own desktop, but don't redistribute it in a client product.
            </p>
            <FieldRow settings={settings} field={{ path: 'activation.pythonPath', kind: 'text', label: 'Python path (optional)', placeholder: 'Auto: %APPDATA%\\Jarvis\\wakeword-venv\\Scripts\\python.exe' }} />
            <span className="row">
              <ActionButton onClick={async () => { const r = await call<{ ok: boolean; detail: string }>('wake:selfTest'); alert(`${r.ok ? 'Self-test passed' : 'Self-test failed'}: ${r.detail}`); }}>Run local self-test</ActionButton>
              <ActionButton kind={snap.armed ? 'danger' : 'primary'} disabled={wake.state !== 'ready' || snap.muted} onClick={() => call('wake:arm', { armed: !snap.armed })}>
                {snap.armed ? 'Disarm hands-free' : 'Arm hands-free'}
              </ActionButton>
              <ExtLink k="pythonDownload">Python for Windows</ExtLink>
            </span>
            <small>The microphone stays off at launch and after sleep until you arm hands-free or press Talk.</small>
          </div>
        )}
      </Card>

      <Card step={7} title="Verify with one real conversation">
        <ul className="checklist">
          <li className={snap.verification.liveConversation ? 'done' : ''}>{snap.verification.liveConversation ? '✓' : '○'} One live voice reply played to the end (Demo mode doesn't count)</li>
          <li className={snap.verification.liveInterruption ? 'done' : ''}>{snap.verification.liveInterruption ? '✓' : '○'} Interrupted a live spoken reply with Stop or Talk</li>
        </ul>
        <p className="muted">Ask one short question, press Stop while it's speaking, then ask a follow-up. Test speakers and headphones separately, and keep half-duplex on if Jarvis hears itself.</p>
        <span className="row">
          <button
            className="primary"
            onClick={async () => {
              await patchSettings({ app: { setupComplete: true } });
              goChat();
            }}
          >
            {snap.verification.liveConversation && snap.verification.liveInterruption ? 'Finish setup' : 'Finish setup (voice not yet verified)'}
          </button>
        </span>
      </Card>
    </div>
  );
}
