import { hmacSha256Hex, timingSafeEqual } from './auth';

// Minimal Stripe REST client built on fetch so it runs natively on Cloudflare Workers.
const STRIPE_API = 'https://api.stripe.com/v1';

export class StripeError extends Error {}

type Params = Record<string, string | number | undefined>;

/** The marketplace only ever talks to Stripe in test mode. */
export function requireTestKey(key: string | undefined): string {
  if (!key) throw new StripeError('Stripe is not configured (set STRIPE_SECRET_KEY to a test key).');
  if (!/^(sk|rk)_test_/.test(key)) throw new StripeError('Refusing to use a live Stripe key; this marketplace runs in Stripe test mode only.');
  return key;
}

async function stripeRequest<T>(key: string, method: 'GET' | 'POST', path: string, params: Params = {}): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
  const url = method === 'GET' && [...body].length ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${requireTestKey(key)}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new StripeError(json.error?.message ?? `Stripe request failed (${res.status})`);
  return json;
}

export type CheckoutSession = {
  id: string;
  url: string | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  payment_intent: string | null;
  metadata: Record<string, string>;
};

export type StripeAccount = { id: string; charges_enabled: boolean; details_submitted: boolean };

export function createCheckoutSession(
  key: string,
  opts: {
    bookingId: number;
    productName: string;
    amountCents: number;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    /** When set, funds go to this connected account minus applicationFeeCents (destination charge). */
    destination?: string | null;
    applicationFeeCents: number;
  },
): Promise<CheckoutSession> {
  const params: Params = {
    mode: 'payment',
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.customerEmail,
    client_reference_id: String(opts.bookingId),
    'metadata[booking_id]': opts.bookingId,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': opts.amountCents,
    'line_items[0][price_data][product_data][name]': opts.productName,
    'payment_intent_data[metadata][booking_id]': opts.bookingId,
  };
  if (opts.destination) {
    params['payment_intent_data[application_fee_amount]'] = opts.applicationFeeCents;
    params['payment_intent_data[transfer_data][destination]'] = opts.destination;
  }
  return stripeRequest<CheckoutSession>(key, 'POST', '/checkout/sessions', params);
}

export function retrieveCheckoutSession(key: string, id: string): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>(key, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);
}

export function createExpressAccount(key: string, email: string, vendorId: number): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>(key, 'POST', '/accounts', {
    type: 'express',
    country: 'US',
    email,
    'capabilities[card_payments][requested]': 'true',
    'capabilities[transfers][requested]': 'true',
    'metadata[vendor_id]': vendorId,
  });
}

export function createAccountLink(key: string, account: string, refreshUrl: string, returnUrl: string): Promise<{ url: string }> {
  return stripeRequest<{ url: string }>(key, 'POST', '/account_links', {
    account,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
}

export function retrieveAccount(key: string, id: string): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>(key, 'GET', `/accounts/${encodeURIComponent(id)}`);
}

/** Verifies a Stripe-Signature header (v1 scheme) against the raw request body. */
export async function verifyWebhookSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = new TextEncoder().encode(await hmacSha256Hex(secret, `${timestamp}.${payload}`));
  return signatures.some((sig) => timingSafeEqual(new TextEncoder().encode(sig), expected));
}
