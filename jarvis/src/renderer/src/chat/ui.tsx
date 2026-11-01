import { useState, type ReactNode } from 'react';
import type { ExternalLinkKey } from '../../../shared/endpoints';
import type { Settings } from '../../../shared/settings';
import { call, errText, getPath, patchSettings, pathPatch } from '../hooks';

export function Card({ title, children, step, status }: { title: string; children: ReactNode; step?: number; status?: ReactNode }) {
  return (
    <section className="card">
      <header>
        <h3>
          {step !== undefined && <span className="step">{step}</span>}
          {title}
        </h3>
        {status}
      </header>
      {children}
    </section>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function ExtLink({ k, children }: { k: ExternalLinkKey; children: ReactNode }) {
  return (
    <button className="link" onClick={() => void call('external:open', { key: k })}>
      {children} ↗
    </button>
  );
}

/** Button that runs an async action, shows busy state, and surfaces errors inline. */
export function ActionButton({ onClick, children, kind = 'secondary', disabled, title }: { onClick: () => Promise<unknown> | unknown; children: ReactNode; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <span className="action">
      <button
        className={kind}
        disabled={disabled || busy}
        title={title}
        onClick={async () => {
          setBusy(true);
          setErr('');
          try {
            await onClick();
          } catch (e) {
            setErr(errText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : children}
      </button>
      {err && <span className="err">{err}</span>}
    </span>
  );
}

/** Two-step confirmation for destructive actions. */
export function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => Promise<unknown> | unknown }) {
  const [armed, setArmed] = useState(false);
  if (!armed) return <button className="danger ghost" onClick={() => setArmed(true)}>{label}</button>;
  return (
    <span className="confirm">
      <button className="danger" onClick={async () => { await onConfirm(); setArmed(false); }}>{confirmLabel}</button>
      <button className="secondary" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  );
}

export type Field = { path: string; label: string; help?: string } & (
  | { kind: 'toggle' }
  | { kind: 'range'; min: number; max: number; step: number; unit?: string }
  | { kind: 'select'; options: Array<[string, string]> }
  | { kind: 'text'; placeholder?: string; max?: number }
  | { kind: 'textarea'; rows: number; max: number }
  | { kind: 'color' }
  | { kind: 'number'; min: number; max: number; step: number; unit?: string }
);

export function FieldRow({ field, settings }: { field: Field; settings: Settings }) {
  const value = getPath(settings, field.path);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const commit = async (v: unknown) => {
    setErr('');
    try {
      await patchSettings(pathPatch(field.path, v));
      setDraft(null);
    } catch (e) {
      setErr(errText(e));
    }
  };
  const id = `f-${field.path}`;
  let control: ReactNode;
  switch (field.kind) {
    case 'toggle':
      control = <input id={id} type="checkbox" checked={!!value} onChange={(e) => void commit(e.target.checked)} />;
      break;
    case 'range':
      control = (
        <span className="range">
          <input id={id} type="range" min={field.min} max={field.max} step={field.step} value={Number(value)} onChange={(e) => void commit(Number(e.target.value))} />
          <output>{Number(value).toFixed(field.step < 1 ? 2 : 0)}{field.unit ?? ''}</output>
        </span>
      );
      break;
    case 'number':
      control = (
        <span className="range">
          <input id={id} type="number" min={field.min} max={field.max} step={field.step} value={draft ?? String(value)} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== null && void commit(Number(draft))} />
          {field.unit && <output>{field.unit}</output>}
        </span>
      );
      break;
    case 'select':
      control = (
        <select id={id} value={String(value)} onChange={(e) => void commit(e.target.value)}>
          {field.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      );
      break;
    case 'color':
      control = <input id={id} type="color" value={String(value)} onChange={(e) => void commit(e.target.value)} />;
      break;
    case 'text':
      control = <input id={id} type="text" maxLength={field.max} placeholder={field.placeholder} value={draft ?? String(value ?? '')} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== null && void commit(draft)} />;
      break;
    case 'textarea':
      control = <textarea id={id} rows={field.rows} maxLength={field.max} value={draft ?? String(value ?? '')} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== null && void commit(draft)} />;
      break;
  }
  return (
    <div className={`field ${field.kind}`}>
      <label htmlFor={id}>{field.label}</label>
      <div className="control">
        {control}
        {field.help && <small>{field.help}</small>}
        {err && <small className="err">{err}</small>}
      </div>
    </div>
  );
}

export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="meter" role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
