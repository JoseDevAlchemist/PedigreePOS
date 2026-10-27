/**
 * Structured error/event logging for server-side jobs.
 *
 * The till's client-side console is where everyday debugging happens, but the
 * M-Pesa integration runs on the server: the STK push lives behind
 * `/api/pos/mpesa/*` and the Safarici webhook arrives there. A payment failure
 * that only ever reaches a browser console is a failure that is never seen, so
 * server-side failures go through here.
 *
 * The shape is deliberately plain JSON-able: `{ scope, operation, context,
 * message, error, loggedAt }`. Structured entries survive a console transport
 * that stringifies whole error objects, and they are easy to ship to a log drain
 * later without a schema migration.
 */

export interface LogContext {
  /** What failed or changed, e.g. `"mpesa"`. */
  scope: string;
  /** Which step of the job, e.g. `"stkpush"`, `"callback"`. */
  operation?: string;
  /** Extra, non-sensitive facts about the event: ids, phone, result codes. */
  context?: Record<string, unknown>;
}

export interface ErrorLog extends LogContext {
  message: string;
  error: {
    name: string;
    message: string;
    stack: string | null;
  };
  loggedAt: string;
}

function describeError(error: unknown): ErrorLog["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return { name: "Error", message: String(error), stack: null };
}

/**
 * Log a failure with structured context and return the entry, so callers can
 * include or inspect it (the M-Pesa layer, for instance, throws an `MpesaError`
 * built from the same facts).
 */
export function logError(context: LogContext, error: unknown): ErrorLog {
  const entry: ErrorLog = {
    scope: context.scope,
    operation: context.operation,
    context: context.context ?? undefined,
    message: describeError(error).message,
    error: describeError(error),
    loggedAt: new Date().toISOString(),
  };

  console.error(entry);

  return entry;
}

/**
 * Log a notable event that is not a failure — a successful STK push, a successful
 * payment callback — so the money movement itself is auditable.
 */
export function logInfo(context: LogContext, details: Record<string, unknown>): void {
  console.info({ ...context, ...details, loggedAt: new Date().toISOString() });
}
