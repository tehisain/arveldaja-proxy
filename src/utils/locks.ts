// Lightweight in-process lock to prevent concurrent processing of the same
// resource. The server runs as a single Node process, so a module-level Set is
// sufficient to close the check-then-act race in the approval handlers: without
// it, two simultaneous approve requests for the same changeset/change can both
// pass the `status === 'pending'` check and execute the underlying write twice,
// producing duplicate financial postings.

const inFlight = new Set<string>();

/**
 * Attempt to acquire the lock for `key`. Returns true if acquired, false if it
 * is already held. Always pair a successful acquire with `release(key)` in a
 * `finally` block.
 */
export function tryAcquire(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function release(key: string): void {
  inFlight.delete(key);
}
