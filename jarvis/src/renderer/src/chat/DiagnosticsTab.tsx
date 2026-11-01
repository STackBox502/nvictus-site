import { useEffect, useState } from 'react';
import type { AppSnapshot } from '../../../shared/types';
import { call } from '../hooks';
import { ActionButton, Card } from './ui';

export function DiagnosticsTab({ snap }: { snap: AppSnapshot }) {
  const [diag, setDiag] = useState<unknown>(null);
  const [include, setInclude] = useState(false);
  useEffect(() => {
    void call('diagnostics:get').then(setDiag);
  }, [snap.state, snap.wake.state]);
  return (
    <div className="diagnostics">
      <Card title="Diagnostics">
        <p className="muted">Versions, statuses, and error codes. API keys are never included. Conversation text is left out unless you tick the box. Telemetry and crash uploads don't exist in this app.</p>
        <span className="row">
          <label className="inline">
            <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Include conversation text in export
          </label>
          <ActionButton onClick={() => call('export:diagnostics', { includeConversation: include })}>Export diagnostics…</ActionButton>
          <button className="danger ghost" onClick={() => void call('app:quit')}>Quit Jarvis</button>
        </span>
        <pre className="diag">{diag ? JSON.stringify(diag, null, 2) : 'Loading…'}</pre>
      </Card>
    </div>
  );
}
