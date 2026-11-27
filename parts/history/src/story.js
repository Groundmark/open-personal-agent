// Turning the three logs into something a person can read.
import path from 'node:path';
import { LOGS, readLog } from './logs.js';

const BINDING = new Set(['book', 'edit_order', 'pay']);

export function allLines(dir) {
  const out = [];
  for (const [src, spec] of Object.entries(LOGS)) for (const l of readLog(path.join(dir, spec.file))) out.push({ src, ...l });
  // By time. At the same instant: what the person said, then reads, then actions, then the agent's reply.
  const rank = (l) => (l.src === 'conversation' ? (l.direction === 'out' ? 3 : 0) : l.src === 'context' ? 1 : 2);
  return out.map((l, i) => ({ l, i })).sort((a, b) => (a.l.ts < b.l.ts ? -1 : a.l.ts > b.l.ts ? 1 : rank(a.l) - rank(b.l) || a.i - b.i)).map((x) => x.l);
}

const grantWhat = (d = {}) => (d.credential ? (typeof d.credential === 'string' ? d.credential : d.credential.domain) : d.session?.origin) || '';

/** One line of the story. */
export function describe(r) {
  const d = r.detail || {};
  if (r.src === 'conversation') {
    if (r.type === 'pairing') return `pairing   ${r.channel}: ${r.event}${r.new_key ? ` (key ${r.old_key || '?'} -> ${r.new_key})` : ''}`;
    return `${r.direction === 'in' ? 'person' : 'agent '}    ${r.text}${r.attachments?.length ? ` [${r.attachments.length} attachment(s)]` : ''}`;
  }
  if (r.src === 'context') return `read      ${r.scope}: ${r.item_ids.length} item(s)${r.query ? ` for "${r.query}"` : ''}`;
  const t = r.type.padEnd(28);
  switch (r.type) {
    case 'grant.requested': return `${t}${d.mode} ${(d.ops || []).join('+')} on ${grantWhat(d)}${d.purpose ? `: ${d.purpose}` : ''}`;
    case 'grant.approved': return `${t}with passkey ${d.passkey_credential_id ?? '?'}`;
    case 'grant.used': return `${t}${d.op}${d.browser ? ` (${d.browser}${d.target ? ` "${d.target}"` : ''})` : ''} ${d.status ?? ''}`
      + `${d.confirmation ? ` confirmation ${d.confirmation}` : ''}${d.store_approval ? ` store asked the person: ${d.store_approval}` : ''}`
      + `${d.source ? ` code from ${d.source}` : ''}${d.mode ? ` [${d.mode}${d.conforming === false ? ', NOT conforming' : ''}]` : ''}`;
    case 'grant.refused': return `${t}${d.error ?? ''}${d.op ? ` (${d.op})` : ''}`;
    case 'identity.declaration': return `${t}for ${d.declaration?.relying_party ?? '?'}, presented: ${d.presented}`;
    default: return `${t}${d.reason ?? ''}`;
  }
}

export function show(dir, errandId) {
  return allLines(dir).filter((r) => r.errand_id === errandId);
}

export function pairing(dir) {
  return allLines(dir).filter((r) => r.src === 'conversation' && r.type === 'pairing');
}

/** One row per errand: when it started and last moved, channels used, and how it ended. */
export function errands(dir) {
  const by = new Map();
  for (const r of allLines(dir)) {
    if (!r.errand_id) continue;
    const e = by.get(r.errand_id) ?? { errand_id: r.errand_id, started: r.ts, last: r.ts, channels: new Set(), done: [], refused: [], denied: 0 };
    e.last = r.ts;
    if (r.src === 'conversation' && r.channel) e.channels.add(r.channel);
    const d = r.detail || {};
    if (r.type === 'grant.used' && BINDING.has(d.op) && d.status === 'ok') e.done.push(d.op + (d.confirmation ? ` ${d.confirmation}` : ''));
    if (r.type === 'grant.refused') e.refused.push(d.error);
    if (r.type === 'grant.denied') e.denied += 1;
    by.set(r.errand_id, e);
  }
  return [...by.values()].map((e) => ({
    errand_id: e.errand_id, started: e.started, last: e.last, channels: [...e.channels],
    outcome: e.done.length ? e.done.join(', ') : e.denied ? 'declined by the person' : e.refused.length ? `refused: ${e.refused.join(', ')}` : 'no binding act',
  }));
}
