// The approval page's script (approval/server.js). Plain browser JavaScript,
// no build step; @simplewebauthn/browser 14.0.0 is loaded before it, from the
// broker, so the page works offline. It asks the broker for the options,
// lets the browser run the passkey (Face ID, Touch ID), and posts the result.
// The broker checks everything; this script decides nothing.

(function () {
  'use strict';
  const { startAuthentication, startRegistration, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;

  async function call(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.message || json.error || `HTTP ${res.status}`);
    return json;
  }

  async function approve(grant) {
    const optionsJSON = await call(`/approve/${grant}/options`);
    const assertion = await startAuthentication({ optionsJSON });
    return call(`/approve/${grant}`, assertion);
  }

  async function enroll(token) {
    const optionsJSON = await call(`/enroll/${token}/options`);
    const attestation = await startRegistration({ optionsJSON });
    return call(`/enroll/${token}`, attestation);
  }

  window.brokerApproval = { approve, enroll };

  const root = document.getElementById('approval');
  const button = document.getElementById('go');
  const status = document.getElementById('status');
  if (!root || !button || !status) return;
  if (!browserSupportsWebAuthn()) {
    status.textContent = 'This browser has no passkey support.';
    button.disabled = true;
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Waiting for your passkey...';
    try {
      if (root.dataset.mode === 'approve') {
        const r = await approve(root.dataset.grant);
        status.textContent = `Approved with your passkey. Grant ${r.grant} is ${r.state}.`;
      } else {
        const r = await enroll(root.dataset.token);
        // No link on to /approve: after the enroll step no grant is waiting
        // there (Checkpoint B snag). The approval comes later, from the console.
        status.textContent = `Passkey registered for ${r.rpId}. Enrollment is closed; you can close this page.`;
      }
    } catch (err) {
      status.textContent = `Not approved: ${err.message}`;
      button.disabled = false;
    }
  });
})();
