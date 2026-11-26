// The approval page's script (approval/server.js). Plain browser JavaScript, no build step;
// @simplewebauthn/browser is loaded before it, from the broker. It asks for the options, lets the
// browser run the passkey (Face ID, Touch ID, PIN), and posts the result. The broker checks everything.
(function () {
  'use strict';
  const { startAuthentication, startRegistration, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;

  async function call(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.message || json.error || `HTTP ${res.status}`);
    return json;
  }

  const root = document.getElementById('approval');
  const go = document.getElementById('go');
  const no = document.getElementById('no');
  const status = document.getElementById('status');
  const revoke = document.getElementById('revoke');
  if (root && revoke && status) {
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try { await call(`/approve/${root.dataset.grant}/revoke`, {}); status.textContent = 'Revoked. Your agent can no longer use this.'; }
      catch (err) { status.textContent = `Not done: ${err.message}`; revoke.disabled = false; }
    });
    return;
  }
  if (!root || !go || !status) return;
  const done = (text) => { status.textContent = text; go.disabled = true; if (no) no.disabled = true; };

  if (!browserSupportsWebAuthn()) { done('This browser has no passkey support.'); return; }

  go.addEventListener('click', async () => {
    go.disabled = true; if (no) no.disabled = true;
    status.textContent = 'Waiting for your passkey…';
    try {
      if (root.dataset.mode === 'approve') {
        const grant = root.dataset.grant;
        const optionsJSON = await call(`/approve/${grant}/options`);
        await call(`/approve/${grant}`, await startAuthentication({ optionsJSON }));
        done('Approved. Your agent can go ahead; you can close this page.');
      } else {
        const token = root.dataset.token;
        const optionsJSON = await call(`/enroll/${token}/options`);
        const r = await call(`/enroll/${token}`, await startRegistration({ optionsJSON }));
        done(`Passkey set up for ${r.rpId}. You can close this page.`);
      }
    } catch (err) {
      status.textContent = `Not done: ${err.message}`;
      go.disabled = false; if (no) no.disabled = false;
    }
  });

  if (no) no.addEventListener('click', async () => {
    go.disabled = true; no.disabled = true;
    try { await call(`/approve/${root.dataset.grant}/decline`, {}); done('Declined. Your agent will not do this.'); }
    catch (err) { status.textContent = `Not done: ${err.message}`; go.disabled = false; no.disabled = false; }
  });
})();
