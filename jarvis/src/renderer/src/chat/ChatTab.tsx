import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Settings } from '../../../shared/settings';
import type { AppSnapshot, ChatMessage } from '../../../shared/types';
import { call, errText } from '../hooks';

/** Renders text safely (React text nodes only); fenced code becomes <pre>. No HTML from the model is ever injected. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```[a-zA-Z0-9_-]*\n?/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <pre key={i}>{p}</pre> : <span key={i} className="pre-wrap">{p}</span>))}
    </>
  );
}

function Message({ m }: { m: ChatMessage }) {
  const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : 'Note';
  const meta: ReactNode[] = [];
  if (m.role === 'assistant' && m.provider) meta.push(`${m.demo ? 'demo' : m.provider === 'anthropic' ? 'Claude' : 'OpenAI'}${m.model && !m.demo ? ` · ${m.model}` : ''}`);
  if (m.source === 'voice') meta.push('voice');
  return (
    <div className={`msg ${m.role}${m.interrupted ? ' interrupted' : ''}${m.error ? ' has-error' : ''}`}>
      <div className="who">
        {who}
        {meta.length > 0 && <span className="meta"> · {meta.join(' · ')}</span>}
      </div>
      <div className="text">
        <RichText text={m.text || (m.pending ? '…' : '')} />
      </div>
      {m.interrupted && (
        <div className="flag">
          Interrupted. {m.heardText ? `Heard up to: “${m.heardText.slice(-120)}”` : 'None of the reply was heard.'} Only the heard part is sent as context.
        </div>
      )}
      {m.voiceUnavailable && <div className="flag">Voice unavailable for this reply. The text is shown.</div>}
      {m.error && <div className="flag error">{m.error}</div>}
    </div>
  );
}

export function ChatTab({ snap, settings }: { snap: AppSnapshot; settings: Settings }) {
  const [text, setText] = useState('');
  const [sendErr, setSendErr] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [snap.messages, snap.partialTranscript]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSendErr('');
    try {
      await call('conv:sendText', { text: t });
      setText('');
    } catch (e) {
      setSendErr(errText(e)); // input is preserved
    }
  };

  const hold = settings.activation.mode === 'push';
  const listening = snap.state === 'listening';
  const other = snap.provider === 'anthropic' ? 'openai' : 'anthropic';
  const otherConfigured = snap.providerConfigured[other];

  return (
    <div className="chat">
      {snap.error && (
        <div className="banner-error" role="alert">
          <strong>{snap.error.message}</strong>
          <span className="actions">
            {snap.canRetry && <button onClick={() => void call('conv:retry')}>Retry</button>}
            <button className="secondary" onClick={() => void call('conv:stop')}>Dismiss</button>
          </span>
        </div>
      )}
      {snap.pendingConfirmation && (
        <div className="banner-confirm" role="alertdialog" aria-label="Confirmation needed">
          <span>{snap.pendingConfirmation.label}</span>
          {snap.pendingConfirmation.data && <small>{snap.pendingConfirmation.data}</small>}
          <span className="actions">
            <button className="danger" onClick={() => void call('conv:confirm', { id: snap.pendingConfirmation!.id, accept: true })}>Confirm</button>
            <button className="secondary" onClick={() => void call('conv:confirm', { id: snap.pendingConfirmation!.id, accept: false })}>Cancel</button>
          </span>
        </div>
      )}
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {snap.messages.length === 0 && (
          <div className="empty">
            {snap.state === 'unconfigured'
              ? 'Finish Setup (or turn on Demo mode) to start talking.'
              : `Say something with Talk, or type below. ${snap.voiceConfigured ? '' : 'Voice output is not configured yet, so replies will be text only.'}`}
          </div>
        )}
        {snap.messages.map((m) => <Message key={m.id} m={m} />)}
        {snap.partialTranscript && (
          <div className="msg user partial">
            <div className="who">You · live transcript</div>
            <div className="text">{snap.partialTranscript}</div>
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          aria-label="Message"
          placeholder={`Message ${settings.personality.assistantName}… (Enter to send, Shift+Enter for a new line)`}
          value={text}
          rows={2}
          maxLength={8000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          <button className="primary" onClick={() => void send()} disabled={!text.trim()}>Send</button>
          {hold ? (
            <button
              className={`talk ${listening ? 'live' : ''}`}
              disabled={snap.muted}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                void call('conv:talk', { action: 'start' });
              }}
              onPointerUp={() => void call('conv:talk', { action: 'end' })}
              title="Hold to talk"
            >
              {listening ? 'Listening… release to send' : 'Hold to talk'}
            </button>
          ) : (
            <button className={`talk ${listening ? 'live' : ''}`} disabled={snap.muted} onClick={() => void call('conv:talk', { action: 'toggle' })}>
              {listening ? 'Send speech' : 'Talk'}
            </button>
          )}
          <button className="secondary" onClick={() => void call('conv:stop')}>Stop</button>
          <button className="secondary" aria-pressed={snap.muted} onClick={() => void call('conv:mute', { muted: !snap.muted })}>{snap.muted ? 'Unmute' : 'Mute'}</button>
        </div>
        {sendErr && <div className="err">{sendErr}</div>}
        <div className="composer-foot">
          <span>
            Hotkeys: Talk <kbd>{snap.shortcuts.talk.accelerator || 'none'}</kbd>{!snap.shortcuts.talk.registered && ' (unavailable, use the tray)'} · Stop <kbd>{snap.shortcuts.stop.accelerator || 'none'}</kbd>
            {!snap.shortcuts.stop.registered && ' (unavailable)'}
          </span>
          <span className="spacer" />
          {(otherConfigured || snap.demoMode) && (
            <button className="link" onClick={() => void call('conv:switchProvider', { provider: other })} title="Existing conversation context will be sent to the newly selected provider">
              Switch to {other === 'openai' ? 'OpenAI' : 'Claude'}
            </button>
          )}
          <button className="link" onClick={() => void call('conv:new')}>New conversation</button>
          <button className="link" onClick={() => void call('export:conversation', { format: 'md' })}>Export</button>
        </div>
      </div>
    </div>
  );
}
