import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  type MenuItemConstructorOptions,
} from 'electron';
import { STATE_LABELS } from '../shared/stateMachine';
import type { Settings } from '../shared/settings';
import { isTrustedOrigin } from '../shared/ipcSchemas';
import type { AudioCommand, ProviderId, ShortcutStatus } from '../shared/types';
import { AssetManager } from './assets';
import { ConversationController } from './controller';
import { registerIpc } from './ipc';
import { Logger } from './log';
import { AnthropicAdapter } from './providers/anthropic';
import { DemoLlm } from './providers/demo';
import { OpenAIAdapter } from './providers/openai';
import { guardedFetch, type FetchFn, type LlmAdapter } from './providers/types';
import { SecretStore, parseDevEnv, type SecretCrypto } from './secrets';
import { DemoStt, ElevenLabsStt } from './speech/stt';
import { DemoTts, ElevenLabsTts } from './speech/tts';
import { listTtsModels, listVoices, validateVoice } from './speech/voices';
import { HistoryStore, MemoryStore, SettingsStore, UsageStore, storePaths } from './stores';
import { PythonWakeService } from './wakeword';
import { OverlayDragger, createChatWindow, createOverlayWindow, drawIcon, placeOverlay, preloadPath, rendererUrl } from './windows';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.nvictus.jarvis');
  void app.whenReady().then(main);
}

let quitting = false;

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  const paths = storePaths(userData);
  const settings = new SettingsStore(paths.settings);
  const memories = new MemoryStore(paths.memories);
  const history = new HistoryStore(paths.history);
  const usage = new UsageStore(paths.usage);
  const assets = new AssetManager(paths.assets);

  const crypto: SecretCrypto = {
    available: async () => {
      try {
        if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') return await safeStorage.isAsyncEncryptionAvailable();
      } catch {
        /* fall through */
      }
      return safeStorage.isEncryptionAvailable();
    },
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result,
  };
  let devEnv = {};
  const envFile = join(app.getAppPath(), '.env.local');
  if (!app.isPackaged && existsSync(envFile)) devEnv = parseDevEnv(readFileSync(envFile, 'utf8'));
  const secrets = new SecretStore(paths.secrets, crypto, devEnv);
  await secrets.init();
  const log = new Logger(paths.log, () => secrets.values());
  log.info('app.start', { version: app.getVersion(), packaged: app.isPackaged });
  for (const p of secrets.loadProblems) log.warn('secrets.load_problem', p);

  // ── Renderer protocol (packaged content only; path traversal blocked) ──
  const rendererRoot = normalize(join(__dirname, '../renderer'));
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'jarvis') return new Response('Not found', { status: 404 });
    const file = normalize(join(rendererRoot, decodeURIComponent(url.pathname)));
    if (!file.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // ── Permission lockdown: microphone (audio only) from the trusted origin; everything else denied ──
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = details.requestingUrl || wc.getURL();
    if (permission === 'media' && isTrustedOrigin(origin, devUrl)) {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return cb(types.length > 0 && types.every((t) => t === 'audio'));
    }
    log.warn('permission.denied', { permission });
    cb(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (!isTrustedOrigin(origin, devUrl)) return false;
    if (permission === 'media') return details.mediaType !== 'video';
    return (permission as string) === 'speaker-selection';
  });
  ses.setDevicePermissionHandler(() => false);
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (ev, url) => {
      if (url !== contents.getURL()) ev.preventDefault();
    });
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });

  // ── Providers (official APIs only, allowlisted hosts) ──
  const fetchFn: FetchFn = guardedFetch((url, init) => net.fetch(url, init));
  const anthropic = new AnthropicAdapter(() => secrets.get('anthropic'), fetchFn);
  const openai = new OpenAIAdapter(() => secrets.get('openai'), fetchFn);
  const demoLlm = new DemoLlm();
  const makeLlm = (p: ProviderId | 'demo'): LlmAdapter => (p === 'demo' ? demoLlm : p === 'anthropic' ? anthropic : openai);

  // ── Wake word (local helper) ──
  const venvPython = (base: string) => (process.platform === 'win32' ? join(base, 'Scripts', 'python.exe') : join(base, 'bin', 'python'));
  const resolvePython = (s: Settings): string => {
    if (s.activation.pythonPath) return s.activation.pythonPath;
    const candidates = [venvPython(join(userData, 'wakeword-venv'))];
    if (!app.isPackaged) candidates.push(venvPython(join(app.getAppPath(), 'wakeword', '.venv')));
    return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
  };
  const helperPath = app.isPackaged ? join(process.resourcesPath, 'wakeword', 'helper.py') : join(app.getAppPath(), 'wakeword', 'helper.py');
  const wake = new PythonWakeService(
    { pythonPath: resolvePython(settings.get()), helperPath, threshold: settings.get().activation.wakeThreshold, model: 'hey_jarvis' },
    (code, meta) => log.info(code, meta),
  );

  // ── Windows ──
  const icon = drawIcon(32);
  const preload = preloadPath();
  let overlay: BrowserWindow | null = null;
  let chat: BrowserWindow | null = null;
  let overlayHiddenByUser = false;
  let overlayReady = false;
  const audioQueue: AudioCommand[] = [];
  const sendAudio = (cmd: AudioCommand) => {
    if (!overlay || overlay.isDestroyed()) return;
    if (!overlayReady) {
      if (audioQueue.length < 50) audioQueue.push(cmd);
      return;
    }
    overlay.webContents.send('audio:cmd', cmd);
  };
  const send = (win: BrowserWindow | null, channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const shortcutState: ShortcutStatus = { talk: { accelerator: '', registered: false }, stop: { accelerator: '', registered: false } };

  // Assigned once below; declared early because window/tray callbacks reference it.
  // eslint-disable-next-line prefer-const
  let controller!: ConversationController;
  const showOverlay = () => {
    const s = settings.get().overlay;
    if (!overlay || s.visibility === 'hidden' || overlayHiddenByUser) return;
    if (!overlay.isVisible()) overlay.showInactive();
  };
  const setOverlayShown = (shown: boolean) => {
    overlayHiddenByUser = !shown;
    if (!overlay) return;
    if (shown) {
      if (settings.get().overlay.visibility === 'hidden') settings.update({ overlay: { visibility: 'onDemand' } });
      overlay.showInactive();
    } else overlay.hide();
    broadcast();
  };

  function createWindows(): void {
    const s = settings.get();
    overlay = createOverlayWindow(preload, rendererUrl('overlay', devUrl), s.overlay);
    overlay.webContents.on('did-finish-load', () => {
      overlayReady = true;
      const st = settings.get();
      overlay?.webContents.send('audio:cmd', { type: 'setOutput', deviceId: st.audio.outputDeviceId, volume: st.audio.outputVolume } satisfies AudioCommand);
      for (const cmd of audioQueue.splice(0)) overlay?.webContents.send('audio:cmd', cmd);
      if (s.overlay.visibility !== 'hidden') overlay?.showInactive();
      broadcast();
    });
    overlay.webContents.on('render-process-gone', () => {
      overlayReady = false;
      log.error('overlay.crashed');
    });
    overlay.on('closed', () => {
      overlay = null;
    });

    chat = createChatWindow(preload, rendererUrl('chat', devUrl), icon);
    chat.on('close', (e) => {
      if (!quitting && settings.get().app.closeToTray) {
        e.preventDefault();
        chat?.hide();
      }
    });
    chat.on('closed', () => {
      chat = null;
    });
    chat.webContents.on('did-finish-load', () => broadcast());
    if (!s.app.setupComplete) chat.once('ready-to-show', () => chat?.show());
  }

  const showChat = (tab?: string) => {
    if (!chat) return;
    chat.show();
    chat.focus();
    if (tab) send(chat, 'nav', tab);
  };

  // ── Tray ──
  let tray: Tray | null = null;
  let lastTrayKey = '';
  function updateTray(): void {
    if (!tray || !controller) return;
    const snap = controller.snapshot();
    const label = snap.preview.active ? 'Visual preview' : STATE_LABELS[snap.state];
    const mic = snap.muted ? 'Mic: muted' : snap.micActive ? (snap.armed ? 'Mic: on (wake word, local only)' : 'Mic: on') : 'Mic: off';
    const key = `${label}|${mic}|${snap.overlayShown}|${snap.muted}|${snap.armed}|${shortcutState.talk.registered}`;
    if (key === lastTrayKey) return;
    lastTrayKey = key;
    tray.setToolTip(`Jarvis — ${label} · ${mic}`);
    tray.setImage(drawIcon(16, snap.muted ? 'muted' : snap.micActive ? 'active' : 'normal'));
    const template: MenuItemConstructorOptions[] = [
      { label: `Jarvis — ${label}`, enabled: false },
      { label: mic, enabled: false },
      { type: 'separator' },
      { label: 'Talk', click: () => controller.talk('toggle', 'hotkey') },
      { label: 'Stop', click: () => controller.stop() },
      { label: snap.muted ? 'Unmute microphone' : 'Mute microphone', click: () => controller.setMuted(!snap.muted) },
      { label: snap.overlayShown ? 'Hide character' : 'Show character', click: () => setOverlayShown(!snap.overlayShown) },
      { label: 'Reset character position', click: () => resetOverlayPosition() },
      { type: 'separator' },
      { label: 'Open chat', click: () => showChat('chat') },
      { label: 'Settings', click: () => showChat('settings') },
      { type: 'separator' },
      { label: 'Quit Jarvis', click: () => quit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  // ── Broadcast ──
  function broadcast(): void {
    if (!controller) return;
    const snap = controller.snapshot();
    send(overlay, 'state', snap);
    send(chat, 'state', snap);
    updateTray();
  }

  // ── Shortcuts (with collision fallbacks; tray always remains as recovery) ──
  function registerShortcuts(): void {
    globalShortcut.unregisterAll();
    const a = settings.get().activation;
    const tryRegister = (candidates: string[], fn: () => void) => {
      for (const acc of candidates.filter(Boolean)) {
        try {
          if (globalShortcut.register(acc, fn)) return { accelerator: acc, registered: true };
        } catch {
          /* invalid accelerator */
        }
      }
      return { accelerator: candidates[0] ?? '', registered: false };
    };
    shortcutState.talk = tryRegister([a.talkShortcut, 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+J'], () => controller.talk('toggle', 'hotkey'));
    shortcutState.stop = tryRegister([a.stopShortcut, 'CommandOrControl+Alt+X'], () => controller.stop());
    for (const k of ['talk', 'stop'] as const) if (!shortcutState[k].registered) log.warn(`shortcut.${k}.failed`);
  }

  const resetOverlayPosition = () => {
    const res = settings.update({ overlay: { position: null, displayId: null } });
    if (res.ok && overlay) placeOverlay(overlay, res.settings.overlay);
    setOverlayShown(true);
  };

  const dragger = new OverlayDragger(
    () => overlay,
    (pos) => settings.update({ overlay: { position: { x: pos.x, y: pos.y }, displayId: pos.displayId, dock: pos.dock } }),
  );

  const quit = () => {
    quitting = true;
    app.quit();
  };

  createWindows();

  controller = new ConversationController({
    settings,
    secrets,
    memories,
    history,
    usage,
    makeLlm,
    makeStt: (opts, demo) => (demo ? new DemoStt(opts) : new ElevenLabsStt(secrets.get('elevenlabs') ?? '', opts)),
    makeTts: (demo) => {
      if (demo) return new DemoTts();
      const v = settings.get().voice;
      const caps = controller.cachedTtsModels().find((m) => m.id === v.ttsModel);
      return new ElevenLabsTts(
        {
          apiKey: secrets.get('elevenlabs') ?? '',
          voiceId: v.voiceId,
          modelId: v.ttsModel,
          outputFormat: v.outputFormat,
          stability: v.stability,
          similarityBoost: v.similarityBoost,
          style: v.style,
          speed: v.speed,
          useSpeakerBoost: v.useSpeakerBoost,
          languageCode: v.languageCode,
          canUseStyle: caps?.canUseStyle ?? false,
          canUseSpeakerBoost: caps?.canUseSpeakerBoost ?? false,
        },
        fetchFn,
      );
    },
    listVoices: () => listVoices(fetchFn, secrets.get('elevenlabs')),
    listTtsModels: () => listTtsModels(fetchFn, secrets.get('elevenlabs')),
    wake,
    audio: { send: sendAudio },
    ui: {
      broadcast: () => broadcast(),
      levels: (input, output) => send(chat, 'levels', { input, output }),
      revealOverlay: showOverlay,
      setOverlayShown,
      overlayShown: () => !!overlay && overlay.isVisible(),
      usageChanged: () => send(chat, 'usage', usage.snapshot()),
    },
    log,
    now: () => Date.now(),
    version: app.getVersion(),
    shortcuts: () => shortcutState,
  });

  registerIpc({
    controller,
    settings,
    secrets,
    memories,
    usage,
    assets,
    log,
    devUrl,
    overlay: () => overlay,
    chat: () => chat,
    listModels: async (p) => {
      const ids = await makeLlm(p).listModels();
      return ids;
    },
    listVoices: async () => {
      const v = await listVoices(fetchFn, secrets.get('elevenlabs'));
      controller.cacheVoices(v);
      return v;
    },
    validateVoice: (id) => validateVoice(fetchFn, secrets.get('elevenlabs'), id),
    listTtsModels: async () => {
      const m = await listTtsModels(fetchFn, secrets.get('elevenlabs'));
      controller.cacheTtsModels(m);
      return m;
    },
    overlayInteractive: (interactive) => {
      if (!overlay) return;
      if (interactive) overlay.setIgnoreMouseEvents(false);
      else overlay.setIgnoreMouseEvents(true, { forward: true });
    },
    overlayDrag: (phase) => (phase === 'start' ? dragger.start() : dragger.end()),
    overlayContextMenu: () => {
      const snap = controller.snapshot();
      Menu.buildFromTemplate([
        { label: 'Talk', click: () => controller.talk('toggle', 'click') },
        { label: 'Stop', click: () => controller.stop() },
        { label: snap.muted ? 'Unmute' : 'Mute', click: () => controller.setMuted(!snap.muted) },
        { label: 'Hide character', click: () => setOverlayShown(false) },
        { type: 'separator' },
        { label: 'Open chat', click: () => showChat('chat') },
        { label: 'Settings', click: () => showChat('settings') },
        { type: 'separator' },
        { label: 'Quit Jarvis', click: () => quit() },
      ]).popup({ window: overlay ?? undefined });
    },
    showChat,
    setOverlayShown,
    resetOverlayPosition,
    broadcastAsset: () => {
      send(overlay, 'asset:changed', null);
      send(chat, 'asset:changed', null);
    },
    audioSend: (cmd) => sendAudio(cmd as AudioCommand),
    wakeDropped: () => wake.dropped,
    quit,
  });

  tray = new Tray(drawIcon(16));
  tray.on('click', () => (chat?.isVisible() ? chat.hide() : showChat()));
  registerShortcuts();
  if (settings.get().activation.mode === 'handsfree') wake.start();
  updateTray();

  settings.onChange((next, prev) => {
    if (overlay) {
      if (next.overlay.alwaysOnTop !== prev.overlay.alwaysOnTop) overlay.setAlwaysOnTop(next.overlay.alwaysOnTop, 'floating');
      if (next.overlay.opacity !== prev.overlay.opacity) overlay.setOpacity(next.overlay.opacity);
      if (next.overlay.scale !== prev.overlay.scale || next.overlay.dock !== prev.overlay.dock || next.overlay.displayId !== prev.overlay.displayId) {
        const moved = next.overlay.position && (next.overlay.position.x !== prev.overlay.position?.x || next.overlay.position.y !== prev.overlay.position?.y);
        if (!moved) {
          const fresh = next.overlay.dock !== prev.overlay.dock || next.overlay.displayId !== prev.overlay.displayId ? { ...next.overlay, position: null } : next.overlay;
          placeOverlay(overlay, fresh);
        }
      }
      if (next.overlay.visibility !== prev.overlay.visibility) {
        if (next.overlay.visibility === 'hidden') overlay.hide();
        else if (!overlayHiddenByUser) overlay.showInactive();
      }
    }
    if (next.activation.talkShortcut !== prev.activation.talkShortcut || next.activation.stopShortcut !== prev.activation.stopShortcut) registerShortcuts();
    if (next.app.launchAtLogin !== prev.app.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.app.launchAtLogin });
    if (next.audio.outputDeviceId !== prev.audio.outputDeviceId || next.audio.outputVolume !== prev.audio.outputVolume)
      sendAudio({ type: 'setOutput', deviceId: next.audio.outputDeviceId, volume: next.audio.outputVolume });
    if (next.activation.pythonPath !== prev.activation.pythonPath || next.activation.wakeThreshold !== prev.activation.wakeThreshold)
      wake.configure({ pythonPath: resolvePython(next), threshold: next.activation.wakeThreshold });
    controller.settingsChanged(next, prev);
    send(overlay, 'settings', next);
    send(chat, 'settings', next);
  });

  // ── OS events ──
  powerMonitor.on('suspend', () => controller.suspend());
  powerMonitor.on('lock-screen', () => controller.suspend());
  const replace = () => overlay && placeOverlay(overlay, settings.get().overlay);
  screen.on('display-removed', replace);
  screen.on('display-added', replace);
  screen.on('display-metrics-changed', replace);

  app.on('second-instance', () => showChat());
  app.on('window-all-closed', () => {
    /* tray app: keep running until Quit */
  });
  app.on('before-quit', () => {
    quitting = true;
    controller.shutdown();
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    log.info('app.quit');
  });
}
