// Context gateway fixture (contracts/context-gateway.md). Fake items, tag-filtered
// scopes, and a hard denylist applied after the filter. Every read is logged.
import { ContractError, ulid, serve } from '../lib/wire.js';
import { Log, newKeyPair } from '../lib/log.js';

export const ITEMS = [
  { id: 'c1', tags: ['dining'], text: 'Prefers quiet tables; dislikes loud music.', captured_at: '2026-10-01T12:00:00Z' },
  { id: 'c2', tags: ['dining'], text: 'Usually books around 19:00 on weekdays.', captured_at: '2026-10-02T12:00:00Z' },
  { id: 'c3', tags: ['dietary'], text: 'No shellfish.', captured_at: '2026-10-03T12:00:00Z' },
  // Denylisted: must never come back, even though one is tagged dining.
  { id: 'd1', tags: ['dining', 'health'], text: 'FIXTURE-HEALTH: low-sodium diet per doctor.', captured_at: '2026-10-04T12:00:00Z' },
  { id: 'd2', tags: ['people-private'], text: 'FIXTURE-PRIVATE: a friend\'s phone number.', captured_at: '2026-10-05T12:00:00Z' },
];

export const SCOPES = {
  dining: { tags: ['dining'], description: 'Restaurant preferences: places, times, ambience.' },
  dietary: { tags: ['dietary'], description: 'What the person does or does not eat.' },
};
export const DENYLIST = ['health', 'medical', 'people-private'];

export class ContextFixture {
  constructor({ logPath, items = ITEMS, scopes = SCOPES, denylist = DENYLIST }) {
    this.key = newKeyPair();
    this.log = new Log(logPath, this.key);
    Object.assign(this, { items, scopes, denylist });
  }

  handlers() {
    return {
      'context.scopes': async () => ({ scopes: Object.entries(this.scopes).map(([name, s]) => ({ name, description: s.description })) }),
      'context.read': async ({ scope, query, limit = 10 }, req) => {
        const s = this.scopes[scope];
        if (!s) throw new ContractError('unknown_scope', scope);
        let hits = this.items.filter((i) => i.tags.some((t) => s.tags.includes(t)));
        if (query) hits = hits.filter((i) => i.text.toLowerCase().includes(query.toLowerCase()));
        hits = hits.filter((i) => !i.tags.some((t) => this.denylist.includes(t))).slice(0, limit);
        const read_id = ulid();
        this.log.append({ errand_id: req.errand_id, type: 'context.read', read_id, scope, query: query ?? '', item_ids: hits.map((h) => h.id) });
        return { read_id, items: hits.map(({ id, text, captured_at }) => ({ id, text, captured_at })) };
      },
    };
  }

  listen(socketPath) { return serve(socketPath, this.handlers()); }
}
