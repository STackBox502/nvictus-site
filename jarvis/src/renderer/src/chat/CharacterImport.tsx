import { useState } from 'react';
import type { Settings } from '../../../shared/settings';
import type { AppSnapshot, ConvState } from '../../../shared/types';
import type { ImageInfo } from '../../../shared/imageCheck';
import { call, errText, patchSettings, useAsset } from '../hooks';
import { ActionButton, ConfirmButton, Pill } from './ui';

interface Pending {
  token: string;
  name: string;
  info: ImageInfo;
  url: string;
  decoded: boolean;
  opaqueCorners: boolean;
}

/** Decodes the picked image locally and checks whether its corners are transparent. */
async function inspect(bytes: Uint8Array, mime: string): Promise<{ url: string; decoded: boolean; opaqueCorners: boolean }> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0, 64, 64);
    const px = [g.getImageData(1, 1, 1, 1), g.getImageData(62, 1, 1, 1), g.getImageData(1, 62, 1, 1), g.getImageData(62, 62, 1, 1)];
    const opaqueCorners = px.every((p) => p.data[3]! > 240);
    bmp.close();
    return { url, decoded: true, opaqueCorners };
  } catch {
    return { url, decoded: false, opaqueCorners: false };
  }
}

const PREVIEW_STATES: ConvState[] = ['idle', 'armed', 'listening', 'thinking', 'speaking', 'muted', 'error'];

export function CharacterImport({ settings, snap }: { settings: Settings; snap: AppSnapshot }) {
  const { asset, url } = useAsset();
  const [pending, setPending] = useState<Pending | null>(null);
  const [err, setErr] = useState('');

  const pick = async () => {
    setErr('');
    const res = await call<{ ok: boolean; token?: string; name?: string; info?: ImageInfo; bytes?: Uint8Array; error?: string; cancelled?: boolean }>('assets:pick');
    if (!res.ok) {
      if (!res.cancelled) setErr(res.error ?? 'Import failed');
      return;
    }
    const meta = await inspect(res.bytes!, res.info!.mime);
    if (pending) URL.revokeObjectURL(pending.url);
    setPending({ token: res.token!, name: res.name!, info: res.info!, ...meta });
  };

  return (
    <div className="character-import">
      <div className="char-row">
        <div className="char-preview checker">{asset && !asset.isPlaceholder && url ? <img src={url} alt="Current character" /> : <span>Placeholder in use</span>}</div>
        <div>
          <p>
            Current: <strong>{asset?.name ?? '…'}</strong> {asset?.isPlaceholder && <Pill tone="warn">placeholder</Pill>}
          </p>
          <span className="row">
            <ActionButton kind="primary" onClick={pick}>Import PNG / WebP…</ActionButton>
            {asset && !asset.isPlaceholder && <ConfirmButton label="Revert to placeholder" confirmLabel="Confirm revert" onConfirm={() => call('assets:reset', { confirm: true })} />}
          </span>
          <small>A transparent PNG works best. The file is copied into the app's data folder, so you can move or delete the original afterwards.</small>
          {err && <small className="err">{err}</small>}
        </div>
      </div>
      {pending && (
        <div className="char-row pending">
          <div className="char-preview checker">{pending.decoded ? <img src={pending.url} alt="Import preview" /> : <span>Could not decode</span>}</div>
          <div>
            <p>
              <strong>{pending.name}</strong> · {pending.info.width}×{pending.info.height} · {pending.info.format.toUpperCase()}
            </p>
            {!pending.info.hasAlphaChannel && <p className="err">This image has no transparency channel, so a solid rectangle will show on your desktop. Use the transparent version if you have one.</p>}
            {pending.info.hasAlphaChannel && pending.opaqueCorners && <p className="err">The corners are opaque. The background may not actually be transparent (for example, a white box). Check the preview on the checkerboard.</p>}
            <span className="row">
              <ActionButton
                kind="primary"
                disabled={!pending.decoded}
                onClick={async () => {
                  try {
                    await call('assets:confirm', { token: pending.token });
                    URL.revokeObjectURL(pending.url);
                    setPending(null);
                  } catch (e) {
                    setErr(errText(e));
                  }
                }}
              >
                Use this image
              </ActionButton>
              <button className="secondary" onClick={() => { URL.revokeObjectURL(pending.url); setPending(null); }}>Cancel</button>
            </span>
          </div>
        </div>
      )}
      <div className="field">
        <label>Motion preset</label>
        <div className="control">
          <span className="row">
            {(['orbit', 'drift', 'still'] as const).map((p) => (
              <button key={p} className={settings.motion.preset === p ? 'primary' : 'secondary'} onClick={() => void patchSettings({ motion: { preset: p } })}>
                {p === 'orbit' ? 'Orbit (bob + trails)' : p === 'drift' ? 'Drift (lateral + glow)' : 'Still'}
              </button>
            ))}
          </span>
          <small>Presets run locally and cost nothing. Fine-tune speed, amplitude, glow, and colours in Settings → Character & motion.</small>
        </div>
      </div>
      <div className="field">
        <label>Visual preview</label>
        <div className="control">
          <span className="row wrap">
            <button className={snap.preview.active ? 'primary' : 'secondary'} onClick={() => void call('preview:set', { active: !snap.preview.active, state: snap.preview.state })}>
              {snap.preview.active ? 'Stop preview' : 'Start preview'}
            </button>
            {PREVIEW_STATES.map((s) => (
              <button key={s} className={snap.preview.active && snap.preview.state === s ? 'primary small' : 'secondary small'} onClick={() => void call('preview:set', { active: true, state: s })}>
                {s}
              </button>
            ))}
          </span>
          <small>Simulated states and levels with no network. The overlay shows a “VISUAL PREVIEW” label, and this never counts as live verification.</small>
        </div>
      </div>
    </div>
  );
}
