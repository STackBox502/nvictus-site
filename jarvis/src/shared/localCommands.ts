import type { ProviderId } from './types';

export type LocalCommand =
  | { kind: 'stop' }
  | { kind: 'mute' }
  | { kind: 'stopListening' }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'switchProvider'; provider: ProviderId }
  | { kind: 'newConversation' }
  | { kind: 'remember'; text: string }
  | { kind: 'listMemories' }
  | { kind: 'forget'; query: string }
  | { kind: 'changeVoice'; name: string }
  | { kind: 'confirm'; accept: boolean };

function normalize(text: string, assistantName: string): string {
  let s = text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const name = assistantName.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
  const lead = new RegExp(`^(?:(?:hey|hi|ok|okay|yo)\\s+)?(?:${name}|jarvis)\\s+`);
  s = s.replace(lead, '');
  s = s.replace(/^(?:please|can you|could you|would you)\s+/, '').replace(/\s+(?:please|now|right now)$/, '');
  return s.trim();
}

/** Strips the same wake/name prefix from original-case text so saved memories keep their casing. */
function stripPrefixOriginal(text: string, assistantName: string): string {
  const name = assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .trim()
    .replace(new RegExp(`^(?:(?:hey|hi|ok|okay|yo)[\\s,]+)?(?:${name}|jarvis)[\\s,.!:]+`, 'i'), '')
    .replace(/^(?:please|can you|could you|would you)\s+/i, '')
    .trim();
}

const QUESTION_START = /^(when|what|how|why|who|where|if|whether|the time|that time|back when)\b/;

/**
 * Matches an utterance against the small set of app-local commands.
 * Only whole-utterance matches count, so ordinary questions ("how do I stop my dog barking?")
 * are never hijacked. Returns null when the utterance should go to the LLM.
 */
export function matchLocalCommand(utterance: string, assistantName = 'Jarvis', hasPendingConfirmation = false): LocalCommand | null {
  const trimmed = utterance.trim();
  if (!trimmed || trimmed.length > 600) return null;
  const s = normalize(trimmed, assistantName);
  if (!s) return null;

  if (hasPendingConfirmation) {
    if (/^(yes|yeah|yep|confirm|do it|go ahead|yes please)$/.test(s)) return { kind: 'confirm', accept: true };
    if (/^(no|nope|cancel|don't|do not|never mind|nevermind)$/.test(s)) return { kind: 'confirm', accept: false };
  }
  if (/^(stop|stop talking|stop speaking|be quiet|quiet|shush|cancel|that's enough|enough|hold on)$/.test(s)) return { kind: 'stop' };
  if (/^(mute|mute yourself|mute the mic|mute the microphone|mute microphone|go mute|turn off the mic|turn off the microphone)$/.test(s)) return { kind: 'mute' };
  if (/^(stop listening|go to sleep|stand by|standby|disarm)$/.test(s)) return { kind: 'stopListening' };
  if (/^(hide|hide yourself|hide the character|hide character|disappear)$/.test(s)) return { kind: 'hide' };
  if (/^(show yourself|show the character|show character|appear|come back)$/.test(s)) return { kind: 'show' };

  const sw = /^(?:switch|change|swap)(?: over)? to (claude|anthropic|openai|open ai|chatgpt|chat gpt|gpt)(?: model)?$/.exec(s);
  if (sw) return { kind: 'switchProvider', provider: /claude|anthropic/.test(sw[1]!) ? 'anthropic' : 'openai' };

  if (/^(new conversation|start a new conversation|start over|reset the conversation|reset conversation|clear the conversation|clear conversation)$/.test(s))
    return { kind: 'newConversation' };
  if (/^(what do you remember|what have you saved|list memories|list my memories|list your memories|show memories|show my memories)$/.test(s))
    return { kind: 'listMemories' };

  if (/\?\s*$/.test(trimmed)) return null;

  const rem = /^remember(?: that)? (.+)$/.exec(s);
  if (rem && !QUESTION_START.test(rem[1]!)) {
    const original = stripPrefixOriginal(trimmed, assistantName).replace(/^remember(?:\s+that)?\s+/i, '').trim();
    const text = original.replace(/[\s.]+$/, '');
    if (text.length >= 3 && text.length <= 500) return { kind: 'remember', text };
  }
  const fg = /^(?:forget|delete the memory|delete memory|remove the memory|remove memory)(?: about| that)? (.{2,200})$/.exec(s);
  if (fg && !/^(it|that|this|about it)$/.test(fg[1]!)) return { kind: 'forget', query: fg[1]! };

  const cv = /^(?:change|switch|set) (?:your |the )?voice to (.{1,60})$/.exec(s);
  if (cv) return { kind: 'changeVoice', name: cv[1]! };
  return null;
}
