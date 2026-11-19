// A static look-alike booking site: home, search, restaurant slots, login, confirm, done.
// Loopback only. Plain HTML forms, no JavaScript, so any browser or HTTP client can drive it.
import http from 'node:http';
import crypto from 'node:crypto';

export const RESTAURANTS = [
  { id: 'harbour-grill', name: 'Harbour Grill', cuisine: 'Seafood', area: 'Waterfront' },
  { id: 'casa-verde', name: 'Casa Verde', cuisine: 'Italian', area: 'Old Town' },
  { id: 'noodle-house', name: 'Noodle House', cuisine: 'Japanese', area: 'Midtown' },
];
const SLOTS = ['17:30', '18:00', '19:00', '19:30', '20:30'];
const USER = { username: 'diner@example.test', password: 'FIXTURE-pa55word-not-real' };

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function startSite({ port = 0, blockAutomation = false } = {}) {
  const sessions = new Map(); // sid -> { user }
  const bookings = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = /sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    const sess = cookie && sessions.get(cookie);
    const send = (code, html, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...headers }); res.end(html); };
    const body = async () => { let b = ''; for await (const c of req) b += c; return Object.fromEntries(new URLSearchParams(b)); };

    // Optional: behave like an edge that refuses declared automation past the home page.
    if (blockAutomation && url.pathname !== '/' && /automation/i.test(req.headers['user-agent'] || '')) {
      return send(403, page('Access Denied', '<p>You don\'t have permission to access this page.</p>'));
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(200, page('Fake Table', `<form action="/search"><label>Where <input name="term"></label>
        <label>Date <input name="date" type="date"></label><label>Time <input name="time"></label>
        <label>People <input name="covers"></label><button>Search</button></form>`));
    }
    if (req.method === 'GET' && url.pathname === '/search') {
      const term = (url.searchParams.get('term') || '').toLowerCase();
      const hits = RESTAURANTS.filter((r) => !term || [r.name, r.cuisine, r.area].some((f) => f.toLowerCase().includes(term)));
      const q = `date=${esc(url.searchParams.get('date'))}&covers=${esc(url.searchParams.get('covers'))}`;
      return send(200, page('Search results', '<ul>' + hits.map((r) =>
        `<li><a href="/r/${r.id}?${q}">${esc(r.name)}</a> · ${esc(r.cuisine)} · ${esc(r.area)}</li>`).join('') + '</ul>'));
    }
    let m;
    if (req.method === 'GET' && (m = /^\/r\/([a-z-]+)$/.exec(url.pathname))) {
      const r = RESTAURANTS.find((x) => x.id === m[1]);
      if (!r) return send(404, page('Not found', ''));
      const d = esc(url.searchParams.get('date')); const c = esc(url.searchParams.get('covers'));
      return send(200, page(r.name, `<p>Available times for ${c} on ${d}:</p><ul>` + SLOTS.map((t) =>
        `<li><a href="/confirm?r=${r.id}&date=${d}&time=${t}&covers=${c}">${t}</a></li>`).join('') + '</ul>'));
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      const next = esc(url.searchParams.get('next') || '/');
      return send(200, page('Sign in', `<form method="post" action="/login"><input type="hidden" name="next" value="${next}">
        <label>Email <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`));
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      const f = await body();
      if (f.username !== USER.username || f.password !== USER.password) return send(401, page('Sign in failed', ''));
      const sid = crypto.randomBytes(16).toString('hex');
      sessions.set(sid, { user: f.username });
      return send(303, '', { location: f.next || '/', 'set-cookie': `sid=${sid}; HttpOnly; Path=/` });
    }
    if (req.method === 'GET' && url.pathname === '/confirm') {
      if (!sess) return send(303, '', { location: '/login?next=' + encodeURIComponent(req.url) });
      const p = Object.fromEntries(url.searchParams);
      const r = RESTAURANTS.find((x) => x.id === p.r);
      return send(200, page('Confirm reservation', `<dl><dt>Venue</dt><dd id="venue">${esc(r?.name)}</dd><dt>Date</dt><dd id="date">${esc(p.date)}</dd>
        <dt>Time</dt><dd id="time">${esc(p.time)}</dd><dt>Party size</dt><dd id="party_size">${esc(p.covers)}</dd></dl>
        <form method="post" action="/book">${['r', 'date', 'time', 'covers'].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('')}
        <button>Complete reservation</button></form>`));
    }
    if (req.method === 'POST' && url.pathname === '/book') {
      if (!sess) return send(401, page('Sign in required', ''));
      const f = await body();
      const r = RESTAURANTS.find((x) => x.id === f.r);
      const conf = 'FT-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      bookings.push({ conf, venue: r?.name, date: f.date, time: f.time, party_size: Number(f.covers), user: sess.user });
      return send(200, page('Reservation confirmed', `<p>Confirmation <strong id="conf">${conf}</strong>: ${esc(r?.name)}, ${esc(f.date)} at ${esc(f.time)}, ${esc(f.covers)} people.</p>`));
    }
    send(404, page('Not found', ''));
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, origin, bookings, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSite({ port: Number(process.env.PORT || 8701) }).then(({ origin }) => console.log(`fake booking site on ${origin}`));
}
