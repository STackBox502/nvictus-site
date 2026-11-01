import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../../shared/settings';
import type { MemoryRecord } from '../../../shared/types';
import { call, errText } from '../hooks';
import { ActionButton, Card, ConfirmButton, FieldRow } from './ui';

export function MemoryTab({ settings }: { settings: Settings }) {
  const [items, setItems] = useState<MemoryRecord[]>([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => void call<MemoryRecord[]>('memory:list').then(setItems), []);
  useEffect(() => {
    load();
    return window.jarvis.on('state', load);
  }, [load]);

  return (
    <div className="memory">
      <Card title="Saved memories">
        <p className="muted">
          Memories are facts you choose to save, either here or by saying “Remember that…”. They're sent to the active brain as context (labelled as context, never as instructions) when “Send saved memories” is on. Stored locally as plain JSON.
        </p>
        <span className="row">
          <input type="text" placeholder="Add a memory, e.g. “My workshop runs on Thursdays”" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
          <ActionButton
            kind="primary"
            disabled={!text.trim()}
            onClick={async () => {
              await call('memory:add', { text });
              setText('');
              setMsg('Saved.');
              load();
            }}
          >
            Save
          </ActionButton>
        </span>
        {msg && <small className="okline">{msg}</small>}
        <ul className="mem-list">
          {items.length === 0 && <li className="muted">No memories yet.</li>}
          {items.map((m) => (
            <li key={m.id}>
              {editing?.id === m.id ? (
                <span className="row">
                  <input type="text" value={editing.text} maxLength={500} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                  <ActionButton kind="primary" onClick={async () => { await call('memory:update', editing); setEditing(null); load(); }}>Save</ActionButton>
                  <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
                </span>
              ) : (
                <>
                  <span className="mem-text">{m.text}</span>
                  <span className="mem-actions">
                    <button className="link" onClick={() => setEditing({ id: m.id, text: m.text })}>Edit</button>
                    <ConfirmButton label="Forget" confirmLabel="Confirm forget" onConfirm={async () => { await call('memory:delete', { id: m.id }); load(); }} />
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        <span className="row">
          <button className="secondary" onClick={() => void call('export:memories', { format: 'md' }).catch((e) => setMsg(errText(e)))}>Export Markdown</button>
          <button className="secondary" onClick={() => void call('export:memories', { format: 'json' }).catch((e) => setMsg(errText(e)))}>Export JSON</button>
          <span className="spacer" />
          {items.length > 0 && <ConfirmButton label="Forget all memories" confirmLabel={`Confirm: delete all ${items.length}`} onConfirm={async () => { await call('memory:clear', { confirm: true }); load(); }} />}
        </span>
      </Card>
      <Card title="Conversation history">
        <FieldRow settings={settings} field={{ path: 'memory.persistHistory', kind: 'toggle', label: 'Save conversation history', help: 'Off = the conversation lives in memory only and disappears when you quit. On = saved as plain (unencrypted) JSON in your Jarvis data folder.' }} />
        <p className="muted">Raw audio is never saved. Encrypting your API keys doesn't encrypt history or memories.</p>
        <span className="row">
          <button className="secondary" onClick={() => void call('export:conversation', { format: 'md' })}>Export conversation (Markdown)</button>
          <button className="secondary" onClick={() => void call('export:conversation', { format: 'json' })}>Export conversation (JSON)</button>
          <button className="secondary" onClick={() => void call('conv:new')}>New conversation</button>
          <span className="spacer" />
          <ConfirmButton label="Delete saved history & clear session" confirmLabel="Confirm delete history" onConfirm={() => call('history:clear', { confirm: true })} />
        </span>
      </Card>
    </div>
  );
}
