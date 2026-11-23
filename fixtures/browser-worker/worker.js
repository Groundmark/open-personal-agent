// Browser worker fixture (contracts/browser-worker.md). A tiny HTTP "browser" that
// drives plain-HTML sites (the fake booking site). It follows links, fills and submits
// forms, keeps cookies, and masks anything filled from the store. The broker calls it
// in-process after checking grants; it is never reached by the core directly.
import { ContractError } from '../lib/wire.js';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const strip = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const BINDING = /complete reservation|pay now|book now|place order/i;

export class BrowserWorker {
  /**
   * store: CredentialStore. getBookGrant(id) -> grant or null (provided by the broker).
   * userAgent: honest by default; the fixture never pretends to be a person.
   */
  constructor({ store, getBookGrant, userAgent = 'open-personal-agent-fixture/0.1 (automation)', mode = 'agent_browser' }) {
    this.store = store;
    this.getBookGrant = getBookGrant;
    this.ua = userAgent;
    this.mode = mode;
    this.sessions = new Map();
    this.n = 0;
  }

  #session(id) {
    const s = this.sessions.get(id);
    if (!s) throw new ContractError('session_not_found', id);
    return s;
  }

  async #fetch(s, url, init = {}) {
    let target = new URL(url, s.url || undefined).toString();
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(target, {
        ...init, redirect: 'manual',
        headers: { 'user-agent': this.ua, cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers || {}) },
      }).catch((e) => { throw new ContractError('navigation_failed', e.message); });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        s.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), target).toString();
        init = {};
        continue;
      }
      const html = await res.text();
      s.url = target; s.html = html; s.form = {}; s.status = res.status;
      if (res.status === 403) {
        throw new ContractError('blocked_by_site', `403 at ${target}: ${/<title>(.*?)<\/title>/.exec(html)?.[1] || ''}`);
      }
      return;
    }
    throw new ContractError('navigation_failed', 'too many redirects');
  }

  #mask(s, text) {
    for (const v of s.masked) text = text.split(v).join('••••');
    return text;
  }

  #page(s, html = s.html) {
    const text = this.#mask(s, strip(html.replace(/<title>.*?<\/title>/s, '')));
    const notices = [...s.html.matchAll(/<[a-z]+[^>]*role="status"[^>]*>([\s\S]*?)<\/[a-z]+>/g)].map((m) => this.#mask(s, strip(m[1])));
    return { url: s.url, title: /<title>(.*?)<\/title>/s.exec(s.html)?.[1] || '', text, ...(notices.length ? { notices } : {}) };
  }

  async open({ url, read_only = false, grant_id = null }) {
    const id = `s${++this.n}`;
    const s = { url: null, html: '', cookies: new Map(), form: {}, masked: new Set(), readOnly: read_only, grantId: grant_id, operatorSignedIn: false };
    this.sessions.set(id, s);
    await this.#fetch(s, url);
    return { session_id: id, page: this.#page(s) };
  }

  /** One region of the page: a <section> by id, aria-label or heading text. */
  async extract({ session_id, target }) {
    const s = this.#session(session_id);
    for (const m of s.html.matchAll(/<section([^>]*)>([\s\S]*?)<\/section>/g)) {
      const [, attrs, inner] = m;
      const heading = strip(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/.exec(inner)?.[1] || '');
      if (attrs.includes(`id="${target}"`) || attrs.includes(`aria-label="${target}"`) || heading === target) {
        return { page: this.#page(s, inner) };
      }
    }
    throw new ContractError('target_not_found', target);
  }

  /**
   * Stands in for the person signing in themselves in their own browser, from their own
   * password manager. The agent's side never sees the values: tests pass them straight here.
   */
  async operatorSignIn(session_id, { username, password }) {
    const s = this.#session(session_id);
    const next = /name="next" value="([^"]*)"/.exec(s.html)?.[1];
    const body = new URLSearchParams({ username, password, ...(next ? { next: decode(next) } : {}) }).toString();
    await this.#fetch(s, '/login', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    s.operatorSignedIn = true;
  }

  async await_login({ session_id, timeout_seconds }) {
    const s = this.#session(session_id);
    const until = Date.now() + timeout_seconds * 1000;
    while (!s.operatorSignedIn) {
      if (Date.now() > until) throw new ContractError('login_timeout', `no sign-in within ${timeout_seconds}s`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return { logged_in: true, login_mode: 'operator_filled' };
  }

  /** Close every session opened under a grant that has ended. Returns how many. */
  closeForGrant(grantId) {
    let n = 0;
    for (const [id, s] of this.sessions) if (s.grantId === grantId) { this.sessions.delete(id); n++; }
    return n;
  }

  #inputForLabel(s, label) {
    const re = new RegExp(`<label>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<input[^>]*name="([^"]+)"`, 'i');
    return re.exec(s.html)?.[1] || (/^[a-z_]+$/.test(label) && s.html.includes(`name="${label}"`) ? label : null);
  }

  /** Values of the form containing the button labelled `label`, plus typed values. */
  #formFor(s, label) {
    for (const m of s.html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)) {
      const [, attrs, inner] = m;
      if (!new RegExp(`<button>\\s*${label}\\s*</button>`, 'i').test(inner)) continue;
      const method = /method="(\w+)"/i.exec(attrs)?.[1]?.toUpperCase() || 'GET';
      const action = /action="([^"]*)"/i.exec(attrs)?.[1] || s.url;
      const fields = {};
      for (const h of inner.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[h[1]] = decode(h[2]);
      for (const i of inner.matchAll(/<input[^>]*name="([^"]+)"/g)) if (s.form[i[1]] !== undefined) fields[i[1]] = s.form[i[1]];
      return { method, action, fields };
    }
    return null;
  }

  #checkBooking(s, bookGrantId) {
    const g = bookGrantId && this.getBookGrant(bookGrantId);
    if (!g) throw new ContractError('constraint_mismatch', 'binding click needs an approved one-shot book grant');
    const shown = (id) => decode(new RegExp(`<dd id="${id}">([^<]*)</dd>`).exec(s.html)?.[1] || '');
    const c = g.constraints;
    const ok = shown('venue') === c.venue && shown('date') === c.date && shown('time') === c.time && Number(shown('party_size')) === c.party_size;
    if (!ok) throw new ContractError('constraint_mismatch', `page shows ${shown('venue')} ${shown('date')} ${shown('time')} x${shown('party_size')}`);
    return g;
  }

  async act({ session_id, action, target, value, book_grant_id }) {
    const s = this.#session(session_id);
    let binding = null;
    if (s.readOnly && (action === 'type' || action === 'select')) {
      throw new ContractError('read_only_session', `${action} is not allowed in a read-only session`);
    }
    if (action === 'type' || action === 'select') {
      if (this.store.allSecretValues().includes(value)) throw new ContractError('secret_value_refused', 'use browser.fill_login');
      const name = this.#inputForLabel(s, target);
      if (!name) throw new ContractError('target_not_found', target);
      s.form[name] = value;
    } else if (action === 'click') {
      const link = [...s.html.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].find((m) => decode(m[2]).trim() === target);
      if (link) {
        await this.#fetch(s, decode(link[1]));
      } else {
        const f = this.#formFor(s, target);
        if (!f) throw new ContractError('target_not_found', target);
        if (s.readOnly) throw new ContractError('read_only_session', `"${target}" submits a form`);
        if (BINDING.test(target)) binding = this.#checkBooking(s, book_grant_id);
        const qs = new URLSearchParams(f.fields).toString();
        if (f.method === 'POST') {
          await this.#fetch(s, f.action, { method: 'POST', body: qs, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        } else {
          await this.#fetch(s, `${f.action}${f.action.includes('?') ? '&' : '?'}${qs}`);
        }
      }
    } else if (!['scroll', 'wait'].includes(action)) {
      throw new ContractError('bad_request', `unknown action ${action}`);
    }
    return { page: this.#page(s), binding };
  }

  async fill_login({ session_id, credential }) {
    const s = this.#session(session_id);
    const c = await this.store.get(credential);
    if (!c) throw new ContractError('credential_not_found', credential);
    if (new URL(s.url).origin !== c.record.origin) throw new ContractError('origin_mismatch', `${new URL(s.url).origin} is not ${c.record.origin}`);
    let filled = 0;
    if (s.html.includes('name="username"')) { s.form.username = c.record.username; filled++; }
    if (/type="password"/.test(s.html)) {
      const name = /<input[^>]*name="([^"]+)"[^>]*type="password"/.exec(s.html)?.[1] || 'password';
      s.form[name] = c.secret.reveal(); s.masked.add(c.secret.reveal()); filled++;
    }
    return { filled };
  }

  /** Fills a one-time code the broker hands over (a Secret). Origin-bound like fill_login; masked in page. */
  async fill_code({ session_id, code }) {
    const s = this.#session(session_id);
    const value = typeof code === 'string' ? code : code.reveal();
    s.form.code = value; s.masked.add(value);
    return { filled: true };
  }

  async close({ session_id }) { this.sessions.delete(session_id); return {}; }
}
