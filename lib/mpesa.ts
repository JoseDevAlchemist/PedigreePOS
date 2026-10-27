/**
 * Lipa Na M-Pesa — the Daraja (Safaricom) M-Pesa API client.
 *
 * Server-only module. It reads the `MPESA_*` server-side environment variables
 * (never `NEXT_PUBLIC_`-prefixed, so the Consumer Secret and Passkey never reach
 * the browser bundle) and owns every outbound M-Pesa call the till makes:
 *
 *   - the OAuth token fetch (`/mpesa/api/v1/token/`) with a short-lived cache,
 *   - the STK Push initiation (`/mpesa/api/v1/stkpush/processrequest`),
 *   - parsing and validation of the Safarici webhook callback.
 *
 * The till-facing routes under `/api/pos/mpesa/*` call into this module, which
 * is what keeps the credentials behind the server: the browser can ask "send the
 * prompt for this amount to this phone" and never see anything but a checkout
 * request id.
 */

import { logError, logInfo } from "@/lib/logger";

export type MpesaEnvironment = "sandbox" | "production";

export interface MpesaConfig {
  environment: MpesaEnvironment;
  consumerKey: string;
  consumerSecret: string;
  /** The Daraja passkey (lipa na m-pesa consumer secret) for the shortcode. */
  passkey: string;
  /** The PayBill shortcode the till charges, e.g. Safaricom's demo `174379`. */
  shortcode: string;
  /** Where Safarici sends the customer's approval result. */
  callbackUrl: string;
}

export class MpesaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpesaError";
  }
}

const SANDBOX = {
  authUrl: "https://api.sandbox.m-pesa.com/mpesa/api/v1/token/",
  apiBaseUrl: "https://api.sandbox.m-pesa.com/mpesa/api/v1",
};

const PRODUCTION = {
  authUrl: "https://api.safaricom.com/mpesa/api/v1/token/",
  apiBaseUrl: "https://api.safaricom.com/mpesa/api/v1",
};

export function getMpesaConfig(): MpesaConfig {
  const environment = (process.env.MPESA_ENV ?? "sandbox").trim().toLowerCase();

  if (environment !== "sandbox" && environment !== "production") {
    throw new MpesaError(
      `Unsupported MPESA_ENV "${environment}". Use "sandbox" or "production".`,
    );
  }

  const consumerKey = process.env.MPESA_CONSUMER_KEY ?? "";
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET ?? "";
  const passkey = process.env.MPESA_PASSKEY ?? "";
  const shortcode = process.env.MPESA_SHORTCODE ?? "";
  const callbackUrl = process.env.MPESA_CALLBACK_URL ?? "";

  if (consumerKey.length === 0 || consumerSecret.length === 0 || passkey.length === 0) {
    throw new MpesaError(
      "M-Pesa is not configured. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET and MPESA_PASSKEY (server-side only) in .env.local.",
    );
  }

  if (shortcode.length === 0 || callbackUrl.length === 0) {
    throw new MpesaError(
      "M-Pesa is not configured. Set MPESA_SHORTCODE and MPESA_CALLBACK_URL in .env.local.",
    );
  }

  return {
    environment: environment === "production" ? "production" : "sandbox",
    consumerKey,
    consumerSecret,
    passkey,
    shortcode,
    callbackUrl,
  };
}

/* ---------------------------------------------------------------------------
   OAuth token — cached per process, refreshed before expiry.
   --------------------------------------------------------------------------- */

interface MpesaTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface MpesaTokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let tokenCache: MpesaTokenCache | null = null;

/** Daraji's `BusinessShortCode + Passkey + Timestamp` password, base64. */
function tokenPassword(config: MpesaConfig, timestamp: string): string {
  return btoa(`${config.shortcode}${config.passkey}${timestamp}`);
}

function mpesaTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** The Daraja endpoints for each environment. */
function darajaUrls(environment: MpesaEnvironment) {
  return environment === "production" ? PRODUCTION : SANDBOX;
}

async function fetchMpesaToken(config: MpesaConfig): Promise<string> {
  const timestamp = mpesaTimestamp();
  const basic = btoa(`${config.consumerKey}:${config.consumerSecret}`);

  const response = await fetch(darajaUrls(config.environment).authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basic}`,
    },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: tokenPassword(config, timestamp),
      Timestamp: timestamp,
    }),
  });

  const data = (await response.json().catch(() => null)) as MpesaTokenResponse | null;

  if (!response.ok || typeof data?.access_token !== "string" || data.access_token.length === 0) {
    const error = new MpesaError(
      `M-Pesa token request failed (${response.status}): ${data?.error_description ?? data?.error ?? "no access token returned"}`,
    );
    logError({ scope: "mpesa", operation: "token" }, error);
    throw error;
  }

  const expiresInSeconds =
    typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  tokenCache = { accessToken: data.access_token, expiresAtMs: Date.now() + expiresInSeconds * 1000 };

  return data.access_token;
}

/** The cached bearer token, fetching and caching on first use. */
export async function getMpesaAccessToken(): Promise<string> {
  const config = getMpesaConfig();
  if (tokenCache !== null && tokenCache.expiresAtMs > Date.now()) {
    return tokenCache.accessToken;
  }
  tokenCache = null;
  return fetchMpesaToken(config);
}

/* ---------------------------------------------------------------------------
   STK Push (Lipa Na M-Pesa)
   --------------------------------------------------------------------------- */

export interface MpesaStkPushInput {
  /** The amount to charge, in whole shillings. */
  amountKes: number;
  /** The customer's phone, normalized to `07XXXXXXXXX`. */
  phoneNumber: string;
  /** The merchant-side reference, e.g. the sale it belongs to. */
  accountReference: string;
  transactionDesc?: string;
}

export interface MpesaStkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
}

/**
 * Send a Lipa Na M-Pesa STK Push to the customer's phone.
 *
 * `TransactionType` is `CustomerPayBill`: Pedigree is the PayBill and the
 * customer's phone is the payer, so the money lands on the configured shortcode.
 *
 * A non-zero `ResponseCode` is a business rejection (the customer has no airtime
 * or opted out), which is a failed payment the till must handle — through the
 * manual fallback — rather than a transport error.
 */
export async function requestMpesaStkPush(
  input: MpesaStkPushInput,
): Promise<MpesaStkPushResult> {
  const config = getMpesaConfig();
  const amountKes = Math.max(1, Math.round(input.amountKes));
  const timestamp = mpesaTimestamp();
  const password = tokenPassword(config, timestamp);

  const response = await fetch(`${darajaUrls(config.environment).apiBaseUrl}/stkpush/processrequest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await getMpesaAccessToken()}`,
    },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBill",
      Amount: String(amountKes),
      PartyA: input.phoneNumber,
      PartyB: config.shortcode,
      PhoneNumber: input.phoneNumber,
      CallBackURL: config.callbackUrl,
      AccountReference: input.accountReference,
      TransactionDesc: input.transactionDesc ?? "Pedigree POS",
    }),
  });

  const data = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  const responseCode =
    typeof data?.ResponseCode === "string"
      ? data.ResponseCode
      : typeof data?.responseCode === "string"
        ? data.responseCode
        : String(data?.ResponseCode ?? data?.responseCode ?? "0");
  const responseDescription =
    typeof data?.ResponseDescription === "string"
      ? data.ResponseDescription
      : String(data?.ResponseDescription ?? data?.responseDescription ?? "");
  const merchantRequestId =
    typeof data?.MerchantRequestID === "string"
      ? data.MerchantRequestID
      : String(data?.MerchantRequestID ?? data?.merchantRequestId ?? "");
  const checkoutRequestId =
    typeof data?.CheckoutRequestID === "string"
      ? data.CheckoutRequestID
      : String(data?.CheckoutRequestID ?? data?.checkoutRequestId ?? "");
  const customerMessage =
    typeof data?.CustomerMessage === "string"
      ? data.CustomerMessage
      : String(data?.CustomerMessage ?? "");

  if (!response.ok) {
    const error = new MpesaError(
      `M-Pesa STK push failed (${response.status}): ${JSON.stringify(data ?? null)}`,
    );
    logError(
      {
        scope: "mpesa",
        operation: "stkpush",
        context: {
          phoneNumber: input.phoneNumber,
          amountKes,
          accountReference: input.accountReference,
          merchantRequestId,
          checkoutRequestId,
        },
      },
      error,
    );
    throw error;
  }

  if (responseCode !== "0") {
    const error = new MpesaError(
      `M-Pesa STK push was not accepted: ${responseDescription || `response code ${responseCode}`}`,
    );
    logError(
      {
        scope: "mpesa",
        operation: "stkpush",
        context: {
          phoneNumber: input.phoneNumber,
          amountKes,
          accountReference: input.accountReference,
          merchantRequestId,
          checkoutRequestId,
          responseCode,
        },
      },
      error,
    );
    throw error;
  }

  logInfo(
    { scope: "mpesa", operation: "stkpush" },
    {
      merchantRequestId,
      checkoutRequestId,
      responseCode,
      amountKes,
      phoneNumber: input.phoneNumber,
      accountReference: input.accountReference,
    },
  );

  return { merchantRequestId, checkoutRequestId, responseCode, responseDescription, customerMessage };
}

/* ---------------------------------------------------------------------------
   Phone normalization and callback parsing
   --------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalize a customer phone to the `07XXXXXXXXX` form Daraja expects, or null
 * when it is not a plausible Kenyan mobile number.
 *
 * Accepts the national form (`07XXXXXXXXX`) and the international form with the
 * country code (`2547XXXXXXXXX`), stripping or adding the leading `0` as needed.
 */
export function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  let national: string | null = null;

  if (digits.length === 10 && digits.startsWith("07")) {
    national = digits;
  } else if (digits.length === 12 && digits.startsWith("254")) {
    national = `0${digits.slice(3)}`;
  }

  if (national === null || !/^0[7-9]\d{8}$/.test(national)) return null;
  return national;
}

export interface MpesaCallback {
  merchantRequestId: string | null;
  checkoutRequestId: string | null;
  resultCode: number;
  resultDescription: string | null;
  phoneNumber: string | null;
  amount: number | null;
  confirmationCode: string | null;
}

/**
 * Parse a Safarici M-Pesa callback payload into the fields the till acts on.
 *
 * The approval lands as:
 *
 * ```json
 * {
 *   "MerchantRequestID": "…",
 *   "CheckoutRequestID": "…",
 *   "ResultCode": 0,
 *   "ResultDesc": "The service request is completed successfully.",
 *   "Body": {
 *     "Msisdn": "0700000000",
 *     "TransactionType": "CustomerPayBill",
 *     "Amount": 12500,
 *     "CallbackMetadata": { "Item": [ { "Key": "MpesaConfirmationCode", "Value": "SJK7Q2LM1P" } ] }
 *   }
 * }
 * ```
 *
 * The metadata is read from `Body` but tolerated at the top level, and the
 * confirmation code is taken from the `MpesaConfirmationCode` item. Anything
 * unreadable is an error rather than a silent `null`, because a callback that
 * cannot be read is exactly the one worth logging.
 */
export function parseMpesaCallback(body: unknown): MpesaCallback {
  if (!isRecord(body)) {
    throw new MpesaError("Malformed M-Pesa callback: body must be a JSON object.");
  }

  const resultCode = typeof body.ResultCode === "number" ? body.ResultCode : Number(body.resultCode ?? 0) || 0;
  const nested = isRecord(body.Body) ? body.Body : {};
  const metadata = isRecord(nested.CallbackMetadata)
    ? nested.CallbackMetadata
    : isRecord(body.CallbackMetadata)
      ? body.CallbackMetadata
      : {};
  const items = Array.isArray(metadata.Item) ? metadata.Item : [];

  let confirmationCode: string | null = null;
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.Key === "MpesaConfirmationCode") {
      confirmationCode = typeof item.Value === "string" && item.Value.length > 0 ? item.Value : null;
      break;
    }
  }

  const rawPhone = typeof nested.Msisdn === "string" ? nested.Msisdn : typeof body.Msisdn === "string" ? body.Msisdn : null;
  const phoneNumber = rawPhone !== null ? normalizePhoneNumber(rawPhone) ?? rawPhone : null;

  return {
    merchantRequestId:
      typeof body.MerchantRequestID === "string" && body.MerchantRequestID.length > 0
        ? body.MerchantRequestID
        : typeof body.merchantRequestId === "string"
          ? body.merchantRequestId
          : null,
    checkoutRequestId:
      typeof body.CheckoutRequestID === "string" && body.CheckoutRequestID.length > 0
        ? body.CheckoutRequestID
        : typeof body.checkoutRequestId === "string"
          ? body.checkoutRequestId
          : null,
    resultCode,
    resultDescription:
      typeof body.ResultDesc === "string" && body.ResultDesc.length > 0
        ? body.ResultDesc
        : typeof body.resultDescription === "string"
          ? body.resultDescription
          : null,
    phoneNumber,
    amount: typeof nested.Amount === "number" ? nested.Amount : typeof body.Amount === "number" ? body.Amount : null,
    confirmationCode,
  };
}
