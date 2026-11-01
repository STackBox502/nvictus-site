import { useEffect, useState } from 'react';
import { STATE_LABELS } from '../../../shared/stateMachine';
import { useSettings, useSnapshot } from '../hooks';
import { ChatTab } from './ChatTab';
import { DiagnosticsTab } from './DiagnosticsTab';
import { MemoryTab } from './MemoryTab';
import { SettingsTab } from './SettingsTab';
import { SetupTab } from './SetupTab';
import { UsageTab } from './UsageTab';
import { Pill } from './ui';

const TABS = [
  ['chat', 'Chat'],
  ['setup', 'Setup'],
  ['settings', 'Settings'],
  ['memory', 'Memory'],
  ['usage', 'Usage'],
  ['diagnostics', 'Diagnostics'],
] as const;
type Tab = (typeof TABS)[number][0];

export function App() {
  const snap = useSnapshot();
  const settings = useSettings();
  const [tab, setTab] = useState<Tab | null>(null);

  useEffect(() => window.jarvis.on('nav', (t) => TABS.some(([k]) => k === t) && setTab(t as Tab)), []);
  useEffect(() => {
    if (tab === null && settings) setTab(settings.app.setupComplete ? 'chat' : 'setup');
  }, [settings, tab]);

  if (!snap || !settings || !tab) return <div className="loading">Loading…</div>;
  const providerLabel = snap.demoMode ? 'Demo' : snap.provider === 'anthropic' ? 'Claude' : 'OpenAI';
  const micTone = snap.muted ? 'muted' : snap.micActive ? 'warn' : 'info';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">◆</span>
          {settings.personality.assistantName}
        </div>
        <div className="status-row" aria-live="polite">
          <Pill tone={snap.state === 'error' ? 'bad' : snap.state === 'unconfigured' ? 'warn' : 'info'}>{STATE_LABELS[snap.state]}</Pill>
          <Pill tone="muted">
            {providerLabel} · {snap.model}
          </Pill>
          <Pill tone={micTone}>{snap.muted ? 'Mic muted' : snap.micActive ? (snap.armed ? 'Mic on · wake word (local)' : 'Mic on') : 'Mic off'}</Pill>
          {snap.demoMode && <Pill tone="warn">DEMO · simulated, no charges</Pill>}
          {snap.preview.active && <Pill tone="warn">VISUAL PREVIEW</Pill>}
        </div>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'chat' && <ChatTab snap={snap} settings={settings} />}
        {tab === 'setup' && <SetupTab snap={snap} settings={settings} goChat={() => setTab('chat')} />}
        {tab === 'settings' && <SettingsTab snap={snap} settings={settings} />}
        {tab === 'memory' && <MemoryTab settings={settings} />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'diagnostics' && <DiagnosticsTab snap={snap} />}
      </main>
    </div>
  );
}
