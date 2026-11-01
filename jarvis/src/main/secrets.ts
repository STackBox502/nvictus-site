import { readJson, writeJson } from './fsutil';
import { maskSecret } from '../shared/redact';
import { SECRET_NAMES, type SecretName, type SecretStatus } from '../shared/types';

/** OS-backed encryption (Electron safeStorage in production, a fake in tests). */
export interface SecretCrypto {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

interface SecretFile {
  version: 1;
  entries: Partial<Record<SecretName, string>>;
}

export class SecretError extends Error {}

/**
 * Credentials live only in the main process. Persistent entries are encrypted with the OS
 * (DPAPI on Windows via safeStorage). When encryption is unavailable, persistence fails closed
 * and only session-only (RAM) entry is allowed.
 */
export class SecretStore {
  private readonly stored = new Map<SecretName, string>();
  private readonly session = new Map<SecretName, string>();
  private encryptionAvailable = false;
  readonly loadProblems: string[] = [];

  constructor(
    private readonly file: string,
    private readonly crypto: SecretCrypto,
    private readonly devEnv: Partial<Record<SecretName, string>> = {},
  ) {}

  async init(): Promise<void> {
    try {
      this.encryptionAvailable = await this.crypto.available();
    } catch {
      this.encryptionAvailable = false;
    }
    const data = readJson(this.file) as SecretFile | undefined;
    if (!data || data.version !== 1 || typeof data.entries !== 'object') return;
    for (const name of SECRET_NAMES) {
      const enc = data.entries[name];
      if (typeof enc !== 'string') continue;
      try {
        this.stored.set(name, await this.crypto.decrypt(Buffer.from(enc, 'base64')));
      } catch {
        this.loadProblems.push(`${name}: stored key could not be decrypted (re-enter it)`);
      }
    }
  }

  get canPersist(): boolean {
    return this.encryptionAvailable;
  }

  get(name: SecretName): string | undefined {
    return this.session.get(name) ?? this.stored.get(name) ?? (this.devEnv[name] || undefined);
  }

  has(name: SecretName): boolean {
    return !!this.get(name);
  }

  async set(name: SecretName, rawValue: string, persist: boolean): Promise<void> {
    const value = rawValue.trim();
    if (value.length < 10 || value.length > 400 || /\s/.test(value)) throw new SecretError('That does not look like an API key (no spaces, 10–400 characters).');
    if (persist) {
      if (!this.encryptionAvailable) throw new SecretError('OS encryption is unavailable, so the key cannot be saved. Use session-only entry instead.');
      const next = new Map(this.stored);
      next.set(name, value);
      await this.writeFile(next);
      this.stored.set(name, value);
      this.session.delete(name);
    } else {
      this.session.set(name, value);
    }
  }

  async delete(name: SecretName): Promise<void> {
    this.session.delete(name);
    if (this.stored.has(name)) {
      const next = new Map(this.stored);
      next.delete(name);
      await this.writeFile(next);
      this.stored.delete(name);
    }
  }

  status(): Record<SecretName, SecretStatus> {
    const out = {} as Record<SecretName, SecretStatus>;
    for (const name of SECRET_NAMES) {
      const source: SecretStatus['source'] = this.session.has(name)
        ? 'session'
        : this.stored.has(name)
          ? 'stored'
          : this.devEnv[name]
            ? 'dev-env'
            : 'none';
      out[name] = { configured: source !== 'none', persisted: source === 'stored', masked: maskSecret(this.get(name)), source };
    }
    return out;
  }

  /** All secret values, for redaction only. */
  values(): string[] {
    return [...this.session.values(), ...this.stored.values(), ...Object.values(this.devEnv)].filter((v): v is string => !!v);
  }

  private async writeFile(entries: Map<SecretName, string>): Promise<void> {
    const out: SecretFile = { version: 1, entries: {} };
    for (const [k, v] of entries) out.entries[k] = (await this.crypto.encrypt(v)).toString('base64');
    writeJson(this.file, out);
  }
}

/** Parses a development-only .env.local (never used when packaged). */
export function parseDevEnv(text: string): Partial<Record<SecretName, string>> {
  const map: Record<string, SecretName> = {
    JARVIS_ANTHROPIC_API_KEY: 'anthropic',
    JARVIS_OPENAI_API_KEY: 'openai',
    JARVIS_ELEVENLABS_API_KEY: 'elevenlabs',
  };
  const out: Partial<Record<SecretName, string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const name = map[m[1]!];
    const value = m[2]!.replace(/^["']|["']$/g, '');
    if (name && value) out[name] = value;
  }
  return out;
}
