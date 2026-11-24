// The chat page. Plain browser JavaScript, no build step, no libraries. The conversation is kept on
// this device only (localStorage); the server keeps none. Approval requests from the agent become a card
// with Approve (your passkey) and Decline, run here against /approve/<id> (passed to the broker).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const log = $('log'), composer = $('composer'), text = $('text');
  const KEY = 'opa-chat-v1';
  const APPROVE = /\n*Approve: https?:\/\/[^\s/]+(\/(?:approve\/[0-9A-HJKMNP-TV-Z]{26}|a\/[0-9A-HJKMNP-TV-Z]{10}))\s*$/;

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { msgs: [], cards: {}, seq: 0 }; } catch { return { msgs: [], cards: {}, seq: 0 }; } };
  const CLIENT = Math.random().toString(36).slice(2);   // this page, so its own messages coming back aren't shown twice
  const state = load();
  const save = () => { try { state.msgs = state.msgs.slice(-300); localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

  const b64u = { enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)) };

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw Object.assign(new Error(json.message || json.error || `HTTP ${res.status}`), { status: res.status, code: json.error });
    return json;
  }

  /** Runs the passkey for options as @simplewebauthn/server makes them; returns the JSON it expects back. */
  async function passkey(o) {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: b64u.dec(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification || 'required',
      allowCredentials: (o.allowCredentials || []).map((c) => ({ type: 'public-key', id: b64u.dec(c.id), transports: c.transports })),
    } });
    const r = cred.response;
    return { id: cred.id, rawId: b64u.enc(cred.rawId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: { clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData), signature: b64u.enc(r.signature),
        userHandle: r.userHandle ? b64u.enc(r.userHandle) : undefined } };
  }

  // ---- rendering ----

  let typing = null;
  function setTyping(on) {
    if (on && !typing) { typing = document.createElement('div'); typing.className = 'typing'; typing.textContent = 'Your agent is thinking…'; log.append(typing); }
    if (!on && typing) { typing.remove(); typing = null; }
    log.scrollTop = log.scrollHeight;
  }

  function card(grant, summary) {
    const el = document.createElement('div');
    el.className = 'card';
    const done = state.cards[grant];
    // What to approve comes from the broker's record of the request, not from the message: that's what the passkey signs.
    const p = document.createElement('p'); p.textContent = done ? summary : 'Loading the request…'; el.append(p);
    if (done) { const d = document.createElement('p'); d.className = 'done'; d.textContent = done; el.append(d); return el; }
    const dl = document.createElement('dl'); dl.className = 'facts'; el.append(dl);
    const row = document.createElement('div'); row.className = 'row';
    const yes = Object.assign(document.createElement('button'), { type: 'button', className: 'approve', textContent: 'Approve' });
    const no = Object.assign(document.createElement('button'), { type: 'button', className: 'decline', textContent: 'Decline' });
    const status = document.createElement('p'); status.className = 'done'; status.setAttribute('role', 'status');
    row.append(yes, no); el.append(row, status);
    yes.disabled = no.disabled = true;
    api(`${grant}/details`).then((d) => {
      p.textContent = d.summary;
      for (const [k, v] of d.facts) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
      if (d.state !== 'pending') finish(d.state === 'approved' || d.state === 'consumed' ? 'Already approved' : 'No longer waiting');
      else yes.disabled = no.disabled = false;
    }).catch(() => { p.textContent = 'Couldn\'t load this request.'; });
    const finish = (said) => { state.cards[grant] = said; save(); row.remove(); status.textContent = said; };
    const fail = (e) => {
      if (e.status === 410) return finish(/approved|consumed/.test(e.message) ? 'Already approved' : 'No longer waiting');
      status.textContent = e.name === 'NotAllowedError' ? 'Cancelled. Tap Approve to try again.' : `Not done: ${e.message}`;
      yes.disabled = no.disabled = false;
    };
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true; status.textContent = 'Waiting for your passkey…';
      try { await api(grant, await passkey(await api(`${grant}/options`))); finish('Approved ✓'); setTyping(true); } catch (e) { fail(e); }
    });
    no.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      try { await api(`${grant}/decline`, {}); finish('Declined'); setTyping(true); } catch (e) { fail(e); }
    });
    return el;
  }

  function render(m) {
    const ask = m.who === 'them' && APPROVE.exec(m.text);
    const words = ask ? m.text.slice(0, ask.index) : m.text;
    const [said, summary] = ask ? splitAsk(words) : [words, null];
    if (said.trim()) { const el = document.createElement('div'); el.className = `msg ${m.who}`; el.textContent = said.trim(); log.append(el); }
    if (ask) log.append(card(ask[1], summary));
    log.scrollTop = log.scrollHeight;
  }
  // The agent's words, then a blank line, then the one-line summary of what to approve.
  function splitAsk(t) { const i = t.lastIndexOf('\n\n'); return i < 0 ? ['', t.trim()] : [t.slice(0, i), t.slice(i + 2).trim()]; }

  function add(who, text) { const m = { who, text, at: Date.now() }; state.msgs.push(m); save(); render(m); }

  // ---- signing in, sending, receiving ----

  // Notifications: offered once signed in, where the browser can do them. On iPhone, only once the chat is on the Home Screen.
  async function offerPush(already) {
    const bar = $('notify-bar');
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.register('/sw.js').catch(() => null);
    if (!reg) return;
    if (!('PushManager' in window)) {
      if (/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone) { $('notify-text').textContent = 'For notifications, add this to your Home Screen (Share, then Add to Home Screen).'; $('notify').hidden = true; bar.hidden = false; }
      return;
    }
    if (already && Notification.permission === 'granted') return;
    if (Notification.permission === 'denied') return;
    bar.hidden = false;
    $('notify').onclick = async () => {
      try {
        if (await Notification.requestPermission() !== 'granted') { bar.hidden = true; return; }
        const { publicKey } = await api('/api/push/key');
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.dec(publicKey) });
        await api('/api/push/subscribe', sub.toJSON());
        bar.hidden = true;
      } catch (e) { $('notify-text').textContent = `Couldn't turn them on: ${e.message}`; }
    };
  }

  function start(me = {}) {
    offerPush(me.push).catch(() => {});
    $('signin').hidden = true; composer.hidden = false; $('signout').hidden = false; $('password').hidden = !state.passwordSignin;
    log.replaceChildren(); state.msgs.forEach(render);
    const es = new EventSource(`/api/events?after=${state.seq || 0}`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      state.seq = ev.seq;   // where to pick up next time (numbering restarts if the server does; the check below covers that)
      const key = ev.message_id || `${ev.client}|${ev.at}`;
      state.seen = (state.seen || []).slice(-300);
      if (state.seen.includes(key)) return save();
      state.seen.push(key);
      if (ev.who === 'me' && ev.client === CLIENT) return save();
      if (ev.who === 'them') setTyping(false);
      add(ev.who, ev.text);
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(() => location.reload(), 3000); };
    text.focus();
  }

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) return;
    text.value = ''; text.style.height = '';
    add('me', t);
    setTyping(true);
    try { await api('/api/send', { text: t, client: CLIENT }); } catch (err) {
      setTyping(false);
      if (err.status === 401) return location.reload();
      add('them', `(Couldn't reach your agent: ${err.message}. Try again in a moment.)`);
    }
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); composer.requestSubmit(); } });
  text.addEventListener('input', () => { text.style.height = ''; text.style.height = `${text.scrollHeight}px`; });

  $('signin-go').addEventListener('click', async () => {
    const s = $('signin-status'); $('signin-go').disabled = true; s.textContent = 'Waiting for your passkey…';
    try { await api('/api/signin', await passkey(await api('/api/signin/options', {}))); start(); }
    catch (e) { s.textContent = e.name === 'NotAllowedError' ? 'Cancelled. On a computer, choose "use a phone" to sign in with your phone, or use your password.' : `Couldn't sign in: ${e.message}`; $('signin-go').disabled = false; }
  });
  // Password fields: the eye shows or hides the password, keeping focus in the field.
  document.querySelectorAll('.eye').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const f = $(b.dataset.for), show = f.type === 'password';
      f.type = show ? 'text' : 'password';
      b.classList.toggle('on', show);
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      f.focus();
    });
  });
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = $('signin-status'); s.textContent = 'Signing in…';
    try { await api('/api/signin/password', { password: $('pw').value }); $('pw').value = ''; s.textContent = ''; start(); }
    catch (err) { s.textContent = err.message; }
  });
  $('password').addEventListener('click', () => { $('set-pw-status').textContent = ''; $('pw-dialog').showModal(); });
  $('set-pw-cancel').addEventListener('click', () => $('pw-dialog').close());
  $('set-pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/password', { password: $('new-pw').value }); $('new-pw').value = ''; $('pw-dialog').close(); add('them', '(Password saved. You can sign in with it on your computer.)'); }
    catch (err) { $('set-pw-status').textContent = err.message; }
  });
  $('signout').addEventListener('click', async () => { await api('/api/signout', {}).catch(() => {}); location.reload(); });

  api('/api/me').then((r) => {
    state.passwordSignin = Boolean(r.password_signin);
    if (r.signed_in) return start(r);
    $('signin').hidden = false; $('pw-form').hidden = !r.has_password;
  }).catch(() => { $('signin').hidden = false; });
})();
