import type { Sql } from '../types';

/**
 * Finds or creates the vendor's CRM contact for this email. Contacts are unique per
 * (vendor, lower(email)), so repeat inquiries and bookings land on the same record.
 */
export async function upsertContact(
  sql: Sql,
  vendorId: number,
  c: { name: string; email: string; phone?: string; source: string; eventDate?: string | null; eventType?: string },
): Promise<number> {
  const rows = await sql`
    INSERT INTO crm_contacts (vendor_id, name, email, phone, source, event_date, event_type)
    VALUES (${vendorId}, ${c.name}, ${c.email.toLowerCase()}, ${c.phone ?? ''}, ${c.source}, ${c.eventDate ?? null}, ${c.eventType ?? ''})
    ON CONFLICT (vendor_id, lower(email)) WHERE email <> '' DO UPDATE SET
      phone      = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE crm_contacts.phone END,
      event_date = COALESCE(EXCLUDED.event_date, crm_contacts.event_date),
      event_type = CASE WHEN EXCLUDED.event_type <> '' THEN EXCLUDED.event_type ELSE crm_contacts.event_type END,
      updated_at = now()
    RETURNING id`;
  return Number(rows[0].id);
}

export async function logActivity(sql: Sql, vendorId: number, contactId: number, kind: string, body: string): Promise<void> {
  await sql`INSERT INTO crm_activities (vendor_id, contact_id, kind, body) VALUES (${vendorId}, ${contactId}, ${kind}, ${body})`;
}

/**
 * Marks a booking paid exactly once (safe to call from both the webhook and the
 * success redirect), then records the payment in the vendor's CRM.
 */
export async function markBookingPaid(sql: Sql, checkoutSessionId: string, paymentIntentId: string | null): Promise<boolean> {
  const rows = await sql`
    UPDATE bookings SET status = 'paid', paid_at = now(), stripe_payment_intent_id = ${paymentIntentId}
    WHERE stripe_checkout_session_id = ${checkoutSessionId} AND status = 'pending_payment'
    RETURNING vendor_id, contact_id, amount_cents, service_title, event_date::text AS event_date`;
  const b = rows[0];
  if (!b) return false;
  if (b.contact_id) {
    const amount = (Number(b.amount_cents) / 100).toFixed(2);
    await sql.transaction([
      sql`UPDATE crm_contacts SET stage = 'booked', updated_at = now()
          WHERE id = ${b.contact_id} AND stage NOT IN ('booked', 'completed')`,
      sql`INSERT INTO crm_activities (vendor_id, contact_id, kind, body)
          VALUES (${b.vendor_id}, ${b.contact_id}, 'payment',
                  ${`Paid $${amount} for "${b.service_title}" (event ${b.event_date}) via Stripe test checkout.`})`,
    ]);
  }
  return true;
}
