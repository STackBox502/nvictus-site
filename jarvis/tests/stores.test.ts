import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, parseDevEnv } from '../src/main/secrets';
import { MemoryStore, SettingsStore, HistoryStore } from '../src/main/stores';
import { readJson } from '../src/main/fsutil';
import { fakeCrypto } from './helpers';

const dir = () => mkdtempSync(join(tmpdir(), 'jarvis-store-'));

describe('secret store', () => {
  it('encrypts persisted keys, never writes plaintext, and reports only masked status', async () => {
    const d = dir();
    const s = new SecretStore(join(d, 'c.json'), fakeCrypto());
    await s.init();
    await s.set('anthropic', 'sk-ant-api03-SECRETVALUE1234', true);
    const raw = readFileSync(join(d, 'c.json'), 'utf8');
    expect(raw).not.toContain('SECRETVALUE1234');
    const st = s.status().anthropic;
    expect(st).toEqual({ configured: true, persisted: true, masked: '••••1234', source: 'stored' });
    expect(JSON.stringify(s.status())).not.toContain('SECRETVALUE');
    const s2 = new SecretStore(join(d, 'c.json'), fakeCrypto());
    await s2.init();
    expect(s2.get('anthropic')).toBe('sk-ant-api03-SECRETVALUE1234');
    await s2.delete('anthropic');
    expect(s2.has('anthropic')).toBe(false);
  });
  it('fails closed when OS encryption is unavailable, allowing session-only keys', async () => {
    const d = dir();
    const s = new SecretStore(join(d, 'c.json'), fakeCrypto(false));
    await s.init();
    await expect(s.set('openai', 'sk-proj-abcdefghijklmnop', true)).rejects.toThrow(/encryption is unavailable/);
    await s.set('openai', 'sk-proj-abcdefghijklmnop', false);
    expect(s.status().openai).toMatchObject({ configured: true, persisted: false, source: 'session' });
    expect(readJson(join(d, 'c.json'))).toBeUndefined();
  });
  it('rejects values that are not key-shaped', async () => {
    const s = new SecretStore(join(dir(), 'c.json'), fakeCrypto());
    await s.init();
    await expect(s.set('openai', 'has spaces in it', false)).rejects.toThrow();
    await expect(s.set('openai', 'short', false)).rejects.toThrow();
  });
  it('parses only known dev env variables', () => {
    expect(parseDevEnv('JARVIS_OPENAI_API_KEY="sk-x-1234567890"\nOTHER=1\nJARVIS_ANTHROPIC_API_KEY=\n')).toEqual({ openai: 'sk-x-1234567890' });
  });
});

describe('memory store', () => {
  it('persists create/edit/delete/clear across reloads', () => {
    const f = join(dir(), 'm.json');
    const m = new MemoryStore(f);
    const a = m.add('  likes   short answers ');
    m.add('workshop on Thursday');
    expect(a.text).toBe('likes short answers');
    m.update(a.id, 'likes concise answers');
    expect(new MemoryStore(f).list().map((x) => x.text)).toEqual(['likes concise answers', 'workshop on Thursday']);
    expect(m.find('thursday workshop')).toHaveLength(1);
    expect(m.delete([a.id])).toBe(1);
    expect(new MemoryStore(f).list()).toHaveLength(1);
    m.clear();
    expect(new MemoryStore(f).list()).toEqual([]);
  });
  it('survives a corrupt file by moving it aside', () => {
    const f = join(dir(), 'm.json');
    writeFileSync(f, '{not json');
    expect(new MemoryStore(f).list()).toEqual([]);
  });
});

describe('settings & history stores', () => {
  it('validates updates, persists, notifies, and keeps secrets out of settings', () => {
    const f = join(dir(), 's.json');
    const s = new SettingsStore(f);
    let changed = 0;
    s.onChange(() => changed++);
    expect(s.update({ overlay: { scale: 9 } }).ok).toBe(false);
    expect(s.update({ overlay: { scale: 1.5 } }).ok).toBe(true);
    expect(changed).toBe(1);
    expect(new SettingsStore(f).get().overlay.scale).toBe(1.5);
    expect(readFileSync(f, 'utf8')).not.toMatch(/sk-|api_key|apiKey/i);
  });
  it('stores history only when saved and clears it', () => {
    const f = join(dir(), 'h.json');
    const h = new HistoryStore(f);
    h.save({ id: 'c1', startedAt: 1, messages: [{ id: '1', role: 'user', text: 'hi', createdAt: 1 }, { id: '2', role: 'assistant', text: '', createdAt: 2, pending: true }] });
    expect(h.load()[0]!.messages).toHaveLength(1);
    h.clear();
    expect(h.load()).toEqual([]);
  });
});
