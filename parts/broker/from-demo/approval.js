// The approval hook: what makes a pending grant active.
// The passkey hook, rungs 1 and 2, is approval/server.js. This file's
// SimulatedApproval is rung 3 of the demo design: no person and no passkey, and its
// record says so with method "simulated", which the log, the console and
// broker-verify all show (criterion 7 is then recorded as not met).
//
//   requested(grant, attach) -> { method, url }
//     called once for each new pending grant. attach(approval) makes it
//     active (GrantStore.approve); the hook calls it when approval arrives.
//   open({ log, stateDir, catalog })  optional; startService calls it once
//     the log is open (the passkey hook listens and opens its store).
//   close()  stops anything pending.
//
// The approval never comes through the caller's socket: a caller cannot
// approve its own grant. Except in one configuration, which says so: a
// SimulatedApproval with autoAfterMs approves every grant any caller asks
// for (an earlier security review). Its label says "AUTO-APPROVES", status reports
// autoApprove, and a service started for the table (--table) refuses it.

export class ApprovalHook {
  get method() { return 'none'; }
  get autoApproves() { return false; }
  requested(grant, attach) { throw new Error('ApprovalHook.requested is not implemented'); }
  close() {}
}

export const SIMULATED_LABEL = 'simulated approval: no person, no passkey (the demo design)';
export const AUTO_LABEL = (ms) => `SIMULATED APPROVAL, AUTO-APPROVES every grant after ${ms} ms: no person, no passkey. Not for the table (the demo design)`;

// autoAfterMs: approve each pending grant after this long (the scripted run,
// tests), or null to leave it pending until approve(id) is called.
export class SimulatedApproval extends ApprovalHook {
  #autoAfterMs;
  #pending = new Map(); // grant id -> { attach, timer }

  constructor({ autoAfterMs = null } = {}) {
    super();
    if (autoAfterMs !== null && !(Number.isInteger(autoAfterMs) && autoAfterMs >= 0)) {
      throw new Error('simulated approval: autoAfterMs must be a non-negative integer or null');
    }
    this.#autoAfterMs = autoAfterMs;
  }

  get method() { return 'simulated'; }
  get autoApproves() { return this.#autoAfterMs !== null; }
  get label() {
    return this.#autoAfterMs === null ? SIMULATED_LABEL : AUTO_LABEL(this.#autoAfterMs);
  }

  requested(grant, attach) {
    const p = { attach, timer: null };
    if (this.#autoAfterMs !== null) {
      p.timer = setTimeout(() => this.approve(grant.id), this.#autoAfterMs);
      p.timer.unref?.();
    }
    this.#pending.set(grant.id, p);
    return { method: 'simulated', url: null };
  }

  // Attaches the simulated approval. Returns the grant, or null if the grant
  // is not waiting here or can no longer be approved (revoked, expired).
  approve(id) {
    const p = this.#pending.get(id);
    if (!p) return null;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    try {
      return p.attach({ method: 'simulated', label: SIMULATED_LABEL, at: new Date().toISOString() });
    } catch (err) {
      console.error(`approval: simulated approval of ${id} not attached: ${err?.code ?? err?.message}`);
      return null;
    }
  }

  close() {
    for (const p of this.#pending.values()) clearTimeout(p.timer);
    this.#pending.clear();
  }
}
