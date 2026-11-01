import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dialog, nativeImage, type BrowserWindow } from 'electron';
import { checkImage, IMAGE_LIMITS, type ImageInfo } from '../shared/imageCheck';
import type { CharacterAsset } from '../shared/types';
import { readJson, writeFileAtomic, writeJson } from './fsutil';

interface Manifest {
  version: 1;
  file: string;
  mime: string;
  name: string;
  width: number;
  height: number;
  hasAlphaChannel: boolean;
  importedAt: string;
}

interface PendingImport {
  bytes: Buffer;
  info: ImageInfo;
  name: string;
  expires: number;
}

/**
 * Character image import. The renderer never supplies a path: main opens the picker, validates the
 * signature/dimensions/size, decodes PNGs, and copies the approved file into the user-data folder.
 */
export class AssetManager {
  private readonly pending = new Map<string, PendingImport>();
  constructor(private readonly dir: string) {}

  private manifestPath(): string {
    return join(this.dir, 'manifest.json');
  }

  current(): CharacterAsset {
    const m = readJson(this.manifestPath()) as Manifest | undefined;
    if (m && m.version === 1 && /^character\.(png|webp)$/.test(m.file)) {
      const p = join(this.dir, m.file);
      if (existsSync(p)) return { isPlaceholder: false, mime: m.mime, bytes: new Uint8Array(readFileSync(p)), name: m.name };
    }
    return { isPlaceholder: true, mime: '', bytes: null, name: 'Placeholder (import your character)' };
  }

  async pick(win: BrowserWindow | null): Promise<
    | { ok: true; token: string; name: string; info: ImageInfo; bytes: Uint8Array }
    | { ok: false; error: string }
    | { ok: false; cancelled: true }
  > {
    const opts = { title: 'Choose your character image', properties: ['openFile' as const], filters: [{ name: 'Transparent image', extensions: ['png', 'webp'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return { ok: false, cancelled: true };
    const file = res.filePaths[0];
    const size = statSync(file).size;
    if (size > IMAGE_LIMITS.maxBytes) return { ok: false, error: `File is larger than ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.` };
    const bytes = readFileSync(file);
    const check = checkImage(bytes);
    if (!check.ok) return { ok: false, error: check.error };
    if (check.info.format === 'png') {
      const img = nativeImage.createFromBuffer(bytes);
      const s = img.getSize();
      if (img.isEmpty() || s.width !== check.info.width || s.height !== check.info.height) return { ok: false, error: 'The PNG could not be decoded.' };
    }
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    const token = randomBytes(16).toString('hex');
    const name = file.split(/[\\/]/).pop()!.slice(0, 120);
    this.pending.set(token, { bytes, info: check.info, name, expires: Date.now() + 10 * 60_000 });
    return { ok: true, token, name, info: check.info, bytes: new Uint8Array(bytes) };
  }

  confirm(token: string): CharacterAsset {
    const p = this.pending.get(token);
    if (!p) throw new Error('Import expired; choose the image again.');
    this.pending.delete(token);
    const file = `character.${p.info.format}`;
    for (const old of ['character.png', 'character.webp']) {
      if (old !== file && existsSync(join(this.dir, old))) unlinkSync(join(this.dir, old));
    }
    writeFileAtomic(join(this.dir, file), p.bytes);
    const manifest: Manifest = {
      version: 1,
      file,
      mime: p.info.mime,
      name: p.name,
      width: p.info.width,
      height: p.info.height,
      hasAlphaChannel: p.info.hasAlphaChannel,
      importedAt: new Date().toISOString(),
    };
    writeJson(this.manifestPath(), manifest);
    return this.current();
  }

  reset(): CharacterAsset {
    for (const f of ['manifest.json', 'character.png', 'character.webp']) {
      const p = join(this.dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    return this.current();
  }
}
