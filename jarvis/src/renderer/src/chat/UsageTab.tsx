import { useEffect, useState } from 'react';
import type { UsageSnapshot, UsageTotals } from '../../../shared/types';
import { call } from '../hooks';
import { Card, ExtLink } from './ui';

function Totals({ t, title }: { t: UsageTotals; title: string }) {
  return (
    <div className="totals">
      <h4>{title}</h4>
      <dl>
        <dt>Turns</dt>
        <dd>{t.turns}</dd>
        <dt>Input tokens (provider-reported)</dt>
        <dd>{t.inputTokens.toLocaleString()}</dd>
        <dt>Output tokens (provider-reported)</dt>
        <dd>{t.outputTokens.toLocaleString()}</dd>
        <dt>Voice characters sent</dt>
        <dd>{t.ttsChars.toLocaleString()}</dd>
        <dt>Listening sent to STT</dt>
        <dd>{t.sttSeconds.toFixed(1)} s</dd>
      </dl>
      {t.incomplete && <small className="err">Some turns had no provider usage report, so totals are incomplete.</small>}
    </div>
  );
}

export function UsageTab() {
  const [u, setU] = useState<UsageSnapshot | null>(null);
  useEffect(() => {
    void call<UsageSnapshot>('usage:get').then(setU);
    return window.jarvis.on('usage', (v) => setU(v as UsageSnapshot));
  }, []);
  if (!u) return <div className="loading">Loading…</div>;
  return (
    <div className="usage">
      <Card title="Usage counters (app-side, not your bill)">
        <p className="muted">
          These counters come from what providers report back plus what this app sent. They aren't billing figures and may lag or differ. For real spend and caps, use the dashboards: <ExtLink k="anthropicBilling">Anthropic</ExtLink> · <ExtLink k="openaiBilling">OpenAI</ExtLink> ·{' '}
          <ExtLink k="elevenlabsUsage">ElevenLabs</ExtLink>
        </p>
        <div className="totals-row">
          <Totals t={u.session} title="This session" />
          <Totals t={u.today} title={`Today (${u.today.date})`} />
        </div>
      </Card>
      <Card title="Response timing (live turns only)">
        <p className="muted">Measured on this computer. p50/p95 appear only after 20+ live samples; until then you see the individual samples.</p>
        <table className="latency">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Samples</th>
              <th>Recent (ms)</th>
              <th>p50</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            {u.latency.map((l) => (
              <tr key={l.stage}>
                <td>{l.stage}</td>
                <td>{l.count}</td>
                <td>{l.recentMs.join(', ') || '—'}</td>
                <td>{l.p50 ?? '—'}</td>
                <td>{l.p95 ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Recent turns">
        <table className="latency">
          <thead>
            <tr>
              <th>Time</th>
              <th>Provider · model</th>
              <th>Outcome</th>
              <th>Tokens in/out</th>
              <th>Voice chars</th>
              <th>STT s</th>
            </tr>
          </thead>
          <tbody>
            {u.recentTurns.map((t) => (
              <tr key={`${t.turnId}-${t.startedAt}`}>
                <td>{new Date(t.startedAt).toLocaleTimeString()}</td>
                <td>{t.live ? `${t.provider} · ${t.model}` : 'demo (simulated)'}</td>
                <td>{t.outcome}</td>
                <td>{t.inputTokens ?? '—'} / {t.outputTokens ?? '—'}</td>
                <td>{t.ttsChars}</td>
                <td>{t.sttSeconds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
