import bcrypt from "bcryptjs";

/**
 * POS identity.
 *
 * Two roles, and only two: a cashier takes money, a manager can also reach the
 * manager area. Anything else the business needs is a permission on top of
 * these, not a third role.
 *
 * ## What this file is and is not
 *
 * The session is kept in `localStorage` because the till has to survive a
 * dropped connection: a cashier cannot be bounced to a login screen because
 * Supabase is unreachable. That makes this a *convenience* boundary, not a
 * security boundary — a determined person with the device and DevTools can
 * edit `localStorage` and call themselves a manager. It stops honest mistakes,
 * and it is what the brief asks for ("store the logged-in user in
 * localStorage"). Real enforcement lives in `pos_users` RLS on the server.
 *
 * PINs are never stored, here or anywhere. Only a bcrypt hash is, and the
 * comparison happens in `verifyPin` — the same code path whether the roster
 * came from the network or from IndexedDB.
 */

export type PosRole = "cashier" | "manager";

export interface PosSession {
  /** `pos_users.id` — a uuid. */
  id: string;
  name: string;
  role: PosRole;
  /** ISO timestamp, for "shifts are too long" checks and a manager audit view. */
  loggedInAt: string;
}

export const POS_SESSION_STORAGE_KEY = "pedigree-pos.session";

/** Long enough to have a little entropy, short enough to type on a numpad. */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 4;

/** bcrypt cost. 10 is ~100ms in a browser tab: slow enough to blunt guessing,
 * fast enough that the keypad does not feel broken. */
export const PIN_HASH_ROUNDS = 10;

export function isPosRole(value: unknown): value is PosRole {
  return value === "cashier" || value === "manager";
}

export function isPosSession(value: unknown): value is PosSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    isPosRole(candidate.role) &&
    typeof candidate.loggedInAt === "string"
  );
}

/** Strip anything that is not a digit, so a pasted "1 2-3 4" still works. */
export function normalizePin(input: string): string {
  return input.replace(/\D/g, "");
}

export function isValidPinFormat(pin: string): boolean {
  return (
    pin.length >= PIN_MIN_LENGTH &&
    pin.length <= PIN_MAX_LENGTH &&
    /^\d+$/.test(pin)
  );
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(normalizePin(pin), PIN_HASH_ROUNDS);
}

/**
 * Constant-ish work regardless of outcome: a malformed hash returns false
 * rather than throwing, so a corrupt roster row cannot crash the login screen.
 */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(normalizePin(pin), hash);
  } catch {
    return false;
  }
}

export function readStoredSession(): PosSession | null {
  if (typeof window === "undefined") return null;
  return parseStoredSession(readRawSession());
}

export function writeStoredSession(session: PosSession | null): void {
  if (typeof window === "undefined") return;
  try {
    if (session === null) {
      window.localStorage.removeItem(POS_SESSION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        POS_SESSION_STORAGE_KEY,
        JSON.stringify(session),
      );
    }
  } catch {
    /* Private-mode quota errors are not worth failing a sign-in over. */
  }
  notifyAuth();
}

/* ---------------------------------------------------------------------------
 * The session as an external store.
 *
 * `localStorage` already holds the truth, so React state would only ever be a
 * copy of it — and a copy that has to be reconciled by an effect on mount, kept
 * in step by hand on every write, and re-read on every `storage` event. Reading
 * it through `useSyncExternalStore` instead removes all three: the store *is*
 * the storage, and one subscription covers the mount read, the cross-tab
 * listener, and the update after a sign-in.
 *
 * The snapshot carries a `hydrated` flag rather than the caller comparing
 * against a default, because "no session stored" and "not read yet" are
 * different answers: the first should send a cashier to the login screen, the
 * second must not act at all. `getServerSnapshot` reports not-yet-hydrated, so
 * the hydrating client render agrees with the HTML it replaces.
 * ------------------------------------------------------------------------- */

export interface AuthSnapshot {
  session: PosSession | null;
  /** False during the server render *and* the hydrating client render. */
  hydrated: boolean;
}

/** Frozen, and returned by identity, so the value React compares is stable. */
const SERVER_AUTH_SNAPSHOT: AuthSnapshot = Object.freeze({
  session: null,
  hydrated: false,
});

/**
 * The cache key. `undefined` means "never read", which is deliberately distinct
 * from "read, nothing stored" — otherwise the first read of an empty
 * `localStorage` would leave the snapshot pointing at the server's.
 */
let lastRaw: string | null | undefined;
let lastSnapshot: AuthSnapshot = SERVER_AUTH_SNAPSHOT;

const authListeners = new Set<() => void>();

export function subscribeAuth(listener: () => void): () => void {
  authListeners.add(listener);
  // `storage` fires only in *other* tabs, which is the one direction that needs
  // telling: the tab that made the change notifies itself directly.
  window.addEventListener("storage", listener);
  return () => {
    authListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function getAuthSnapshot(): AuthSnapshot {
  const raw = readRawSession();
  if (raw !== lastRaw) {
    lastRaw = raw;
    // A fresh object only when the stored bytes actually changed, so React's
    // `Object.is` check can settle instead of re-rendering forever.
    lastSnapshot = { session: parseStoredSession(raw), hydrated: true };
  }
  return lastSnapshot;
}

export function getServerAuthSnapshot(): AuthSnapshot {
  return SERVER_AUTH_SNAPSHOT;
}

export function notifyAuth(): void {
  for (const listener of authListeners) listener();
}

function readRawSession(): string | null {
  try {
    return window.localStorage.getItem(POS_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parseStoredSession(raw: string | null): PosSession | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPosSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createSession(input: {
  id: string;
  name: string;
  role: PosRole;
}): PosSession {
  return {
    id: input.id,
    name: input.name,
    role: input.role,
    loggedInAt: new Date().toISOString(),
  };
}
