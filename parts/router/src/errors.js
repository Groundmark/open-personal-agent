/** An error from the router contract's closed list. `message` never holds a secret or a prompt. */
export class RouterError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
