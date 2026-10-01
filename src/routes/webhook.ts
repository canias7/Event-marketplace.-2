import { Hono } from 'hono';
import { markBookingPaid } from '../lib/crm';
import { verifyWebhookSignature, type CheckoutSession, type StripeAccount } from '../lib/stripe';
import type { AppEnv } from '../types';

export const webhookRoutes = new Hono<AppEnv>();

// Configure in Stripe (test mode) → Developers → Webhooks, pointing at /stripe/webhook with events:
//   checkout.session.completed, checkout.session.async_payment_succeeded, account.updated
// For account.updated, add a second endpoint that listens to events on Connected accounts
// and put its signing secret in STRIPE_CONNECT_WEBHOOK_SECRET.
webhookRoutes.post('/webhook', async (c) => {
  // A Connect endpoint has its own signing secret, so accept either.
  const secrets = [c.env.STRIPE_WEBHOOK_SECRET, c.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter((s): s is string => !!s);
  if (secrets.length === 0) return c.text('Webhook secret not configured', 500);
  const payload = await c.req.text();
  const signature = c.req.header('stripe-signature');
  let valid = false;
  for (const secret of secrets) valid ||= await verifyWebhookSignature(payload, signature, secret);
  if (!valid) return c.text('Invalid signature', 400);
  const event = JSON.parse(payload) as { type: string; livemode: boolean; data: { object: unknown } };
  if (event.livemode) return c.text('Live-mode events are ignored', 200);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as CheckoutSession;
      if (session.payment_status === 'paid') await markBookingPaid(c.var.sql, session.id, session.payment_intent);
      break;
    }
    case 'checkout.session.expired': {
      const session = event.data.object as CheckoutSession;
      await c.var.sql`UPDATE bookings SET status = 'cancelled' WHERE stripe_checkout_session_id = ${session.id} AND status = 'pending_payment'`;
      break;
    }
    case 'account.updated': {
      const account = event.data.object as StripeAccount;
      await c.var.sql`UPDATE vendors SET stripe_charges_enabled = ${account.charges_enabled} WHERE stripe_account_id = ${account.id}`;
      break;
    }
  }
  return c.json({ received: true });
});
