import { Hono } from 'hono';
import { html } from 'hono/html';
import { logActivity } from '../lib/crm';
import {
  ACTIVITY_KINDS,
  CRM_STAGES,
  field,
  fmtDate,
  fmtDateTime,
  isEmail,
  isUniqueViolation,
  money,
  parseDate,
  parseMoney,
  todayUtc,
  withError,
  withMsg,
  type Form,
} from '../lib/util';
import { layout, options } from '../lib/views';
import type { VendorEnv } from '../types';

// Every query here is scoped by vendor_id = the logged-in vendor, so each vendor
// only ever sees and edits their own CRM data.
export const crmRoutes = new Hono<VendorEnv>();

function contactInput(f: Form) {
  const name = field(f, 'name', 120);
  const email = field(f, 'email', 254).toLowerCase();
  const stage = field(f, 'stage', 20);
  const rawDate = field(f, 'event_date');
  const rawBudget = field(f, 'budget', 20);
  const eventDate = rawDate ? parseDate(rawDate) : null;
  const budget = rawBudget ? parseMoney(rawBudget) : null;
  if (!name) return 'Name is required.';
  if (email && !isEmail(email)) return 'Email is not valid.';
  if (!(CRM_STAGES as readonly string[]).includes(stage)) return 'Unknown stage.';
  if (rawDate && !eventDate) return 'Event date is not valid.';
  if (rawBudget && budget === null) return 'Budget is not a valid amount.';
  return {
    name,
    email,
    stage,
    phone: field(f, 'phone', 40),
    eventType: field(f, 'event_type', 80),
    eventDate,
    budget,
  } as const;
}

function contactFields(ct: Record<string, any> = { stage: 'lead' }) {
  return html`
    <label>Name <input name="name" required maxlength="120" value="${ct.name ?? ''}"></label>
    <label>Email <input name="email" type="email" maxlength="254" value="${ct.email ?? ''}"></label>
    <label>Phone <input name="phone" maxlength="40" value="${ct.phone ?? ''}"></label>
    <label>Stage <select name="stage">${options(CRM_STAGES, ct.stage)}</select></label>
    <label>Event type <input name="event_type" maxlength="80" value="${ct.event_type ?? ''}"></label>
    <label>Event date <input name="event_date" type="date" value="${fmtDate(ct.event_date)}"></label>
    <label>Budget (USD) <input name="budget" value="${ct.budget_cents != null ? (ct.budget_cents / 100).toFixed(2) : ''}"></label>`;
}

crmRoutes.get('/', async (c) => {
  const { sql, vendor } = c.var;
  const stage = c.req.query('stage') ?? '';
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const like = `%${q}%`;
  const [counts, contacts] = await sql.transaction([
    sql`SELECT stage, count(*)::int AS n FROM crm_contacts WHERE vendor_id = ${vendor.id} GROUP BY stage`,
    sql`
      SELECT ct.id, ct.name, ct.email, ct.phone, ct.stage, ct.source, ct.event_type, ct.event_date::text AS event_date, ct.updated_at,
             (SELECT coalesce(sum(amount_cents), 0) FROM bookings b
               WHERE b.contact_id = ct.id AND b.status IN ('paid', 'completed')) AS lifetime_cents
      FROM crm_contacts ct
      WHERE ct.vendor_id = ${vendor.id}
        AND (${stage} = '' OR ct.stage = ${stage})
        AND (${q} = '' OR ct.name ILIKE ${like} OR ct.email ILIKE ${like} OR ct.phone ILIKE ${like})
      ORDER BY ct.updated_at DESC LIMIT 500`,
  ]);
  const byStage = Object.fromEntries(counts.map((r) => [r.stage, r.n]));
  const total = counts.reduce((n, r) => n + r.n, 0);

  return c.html(
    layout(
      'CRM',
      html`<h1>CRM — contacts &amp; pipeline</h1>
        <p>
          <a href="/vendor/crm">all (${total})</a>
          ${CRM_STAGES.map((s) => html` · <a href="/vendor/crm?stage=${s}">${stage === s ? html`<b>${s}</b>` : s} (${byStage[s] ?? 0})</a>`)}
        </p>
        <form method="get" action="/vendor/crm">
          ${stage ? html`<input type="hidden" name="stage" value="${stage}">` : ''}
          <input name="q" value="${q}" placeholder="Search name, email, phone"> <button>Search</button>
          · <a href="/vendor/crm/new">+ New contact</a> · <a href="/vendor/crm/export.csv">Export CSV</a>
        </form>
        <table>
          <tr><th>Name</th><th>Contact</th><th>Stage</th><th>Event</th><th>Source</th><th>Lifetime value</th><th>Updated</th></tr>
          ${contacts.map(
            (ct) => html`<tr>
              <td><a href="/vendor/crm/${ct.id}">${ct.name}</a></td>
              <td>${ct.email}<div class="muted">${ct.phone}</div></td>
              <td><span class="badge">${ct.stage}</span></td>
              <td>${ct.event_type} ${fmtDate(ct.event_date)}</td>
              <td>${ct.source}</td>
              <td>${money(ct.lifetime_cents)}</td>
              <td>${fmtDateTime(ct.updated_at)}</td>
            </tr>`,
          )}
        </table>
        ${contacts.length === 0 ? html`<p class="muted">No contacts. Inquiries and bookings from your public page appear here automatically.</p>` : ''}`,
      { vendor, msg: c.req.query('msg') },
    ),
  );
});

crmRoutes.get('/export.csv', async (c) => {
  const { sql, vendor } = c.var;
  const rows = await sql`
    SELECT name, email, phone, stage, source, event_type, event_date::text AS event_date, budget_cents, created_at
    FROM crm_contacts WHERE vendor_id = ${vendor.id} ORDER BY created_at`;
  const cols = ['name', 'email', 'phone', 'stage', 'source', 'event_type', 'event_date', 'budget_cents', 'created_at'];
  const cell = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\r\n');
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${vendor.slug}-contacts.csv"`,
  });
});

crmRoutes.get('/new', (c) =>
  c.html(
    layout(
      'New contact',
      html`<p><a href="/vendor/crm">← CRM</a></p>
        <h1>New contact</h1>
        <form method="post" action="/vendor/crm" class="stack">
          ${contactFields()}
          <label>First note <textarea name="note" maxlength="4000"></textarea></label>
          <button>Create contact</button>
        </form>`,
      { vendor: c.var.vendor, error: c.req.query('error') },
    ),
  ),
);

crmRoutes.post('/', async (c) => {
  const { sql, vendor } = c.var;
  const f = await c.req.parseBody();
  const input = contactInput(f);
  if (typeof input === 'string') return c.redirect(withError('/vendor/crm/new', input), 303);
  let id: number;
  try {
    const [row] = await sql`
      INSERT INTO crm_contacts (vendor_id, name, email, phone, stage, source, event_type, event_date, budget_cents)
      VALUES (${vendor.id}, ${input.name}, ${input.email}, ${input.phone}, ${input.stage}, 'manual',
              ${input.eventType}, ${input.eventDate}, ${input.budget})
      RETURNING id`;
    id = Number(row.id);
  } catch (e) {
    if (isUniqueViolation(e)) return c.redirect(withError('/vendor/crm/new', 'A contact with that email already exists.'), 303);
    throw e;
  }
  const note = field(f, 'note', 4000);
  if (note) await logActivity(sql, vendor.id, id, 'note', note);
  return c.redirect(withMsg(`/vendor/crm/${id}`, 'Contact created.'), 303);
});

crmRoutes.get('/:id{[0-9]+}', async (c) => {
  const { sql, vendor } = c.var;
  const id = c.req.param('id')!;
  const [[ct], activities, tasks, bookings] = await sql.transaction([
    sql`SELECT *, event_date::text AS event_date FROM crm_contacts WHERE id = ${id} AND vendor_id = ${vendor.id}`,
    sql`SELECT kind, body, created_at FROM crm_activities WHERE contact_id = ${id} AND vendor_id = ${vendor.id} ORDER BY created_at DESC, id DESC`,
    sql`SELECT id, title, due_date::text AS due_date, done FROM crm_tasks WHERE contact_id = ${id} AND vendor_id = ${vendor.id} ORDER BY done, due_date NULLS LAST`,
    sql`SELECT service_title, event_date::text AS event_date, amount_cents, status, created_at FROM bookings
        WHERE contact_id = ${id} AND vendor_id = ${vendor.id} ORDER BY created_at DESC`,
  ]);
  if (!ct) return c.notFound();

  return c.html(
    layout(
      ct.name,
      html`<p><a href="/vendor/crm">← CRM</a></p>
        <h1>${ct.name} <span class="badge">${ct.stage}</span></h1>
        <p class="muted">Source: ${ct.source} · Created ${fmtDateTime(ct.created_at)}</p>
        <div class="cols">
          <div>
            <h2>Details</h2>
            <form method="post" action="/vendor/crm/${ct.id}" class="stack">
              ${contactFields(ct)}
              <button>Save</button>
            </form>
            <h2>Tasks</h2>
            <ul>
              ${tasks.map(
                (t) => html`<li>
                  <form method="post" action="/vendor/tasks/${t.id}/toggle" class="inline">
                    <input type="hidden" name="back" value="/vendor/crm/${ct.id}">
                    <button title="Toggle done">${t.done ? '☑' : '☐'}</button>
                  </form>
                  ${t.done ? html`<s>${t.title}</s>` : t.title} ${t.due_date ? html`<span class="muted">due ${fmtDate(t.due_date)}</span>` : ''}
                </li>`,
              )}
            </ul>
            <form method="post" action="/vendor/tasks" class="stack">
              <input type="hidden" name="contact_id" value="${ct.id}">
              <label>New task <input name="title" required maxlength="200" placeholder="Send proposal"></label>
              <label>Due <input name="due_date" type="date" min="${todayUtc()}"></label>
              <button>Add task</button>
            </form>
            <h2>Bookings</h2>
            ${bookings.length === 0 ? html`<p class="muted">No bookings.</p>` : ''}
            <ul>${bookings.map((b) => html`<li>${b.service_title} — ${fmtDate(b.event_date)} — ${money(b.amount_cents)} <span class="badge">${b.status}</span></li>`)}</ul>
            <form method="post" action="/vendor/crm/${ct.id}/delete" onsubmit="return confirm('Delete this contact and its history?')">
              <button>Delete contact</button>
            </form>
          </div>
          <div>
            <h2>Log activity</h2>
            <form method="post" action="/vendor/crm/${ct.id}/activities" class="stack">
              <label>Type <select name="kind">${options(ACTIVITY_KINDS)}</select></label>
              <label>Details <textarea name="body" required maxlength="4000"></textarea></label>
              <button>Add to timeline</button>
            </form>
            <h2>Timeline</h2>
            ${activities.length === 0 ? html`<p class="muted">No activity yet.</p>` : ''}
            ${activities.map(
              (a) => html`<div class="card" style="margin-bottom:8px">
                <span class="badge">${a.kind}</span> <span class="muted">${fmtDateTime(a.created_at)}</span>
                <div style="white-space:pre-line">${a.body}</div>
              </div>`,
            )}
          </div>
        </div>`,
      { vendor, msg: c.req.query('msg'), error: c.req.query('error') },
    ),
  );
});

crmRoutes.post('/:id{[0-9]+}', async (c) => {
  const { sql, vendor } = c.var;
  const id = c.req.param('id')!;
  const input = contactInput(await c.req.parseBody());
  if (typeof input === 'string') return c.redirect(withError(`/vendor/crm/${id}`, input), 303);
  const [before] = await sql`SELECT stage FROM crm_contacts WHERE id = ${id} AND vendor_id = ${vendor.id}`;
  if (!before) return c.notFound();
  try {
    await sql`
      UPDATE crm_contacts SET name = ${input.name}, email = ${input.email}, phone = ${input.phone}, stage = ${input.stage},
        event_type = ${input.eventType}, event_date = ${input.eventDate}, budget_cents = ${input.budget}, updated_at = now()
      WHERE id = ${id} AND vendor_id = ${vendor.id}`;
  } catch (e) {
    if (isUniqueViolation(e)) return c.redirect(withError(`/vendor/crm/${id}`, 'Another contact already uses that email.'), 303);
    throw e;
  }
  if (before.stage !== input.stage) {
    await logActivity(sql, vendor.id, Number(id), 'stage_change', `Stage changed from ${before.stage} to ${input.stage}.`);
  }
  return c.redirect(withMsg(`/vendor/crm/${id}`, 'Saved.'), 303);
});

crmRoutes.post('/:id{[0-9]+}/activities', async (c) => {
  const { sql, vendor } = c.var;
  const id = c.req.param('id')!;
  const f = await c.req.parseBody();
  const kind = field(f, 'kind', 20);
  const body = field(f, 'body', 4000);
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind) || !body) return c.redirect(withError(`/vendor/crm/${id}`, 'Activity text is required.'), 303);
  const [ct] = await sql`
    UPDATE crm_contacts SET updated_at = now() WHERE id = ${id} AND vendor_id = ${vendor.id} RETURNING id`;
  if (!ct) return c.notFound();
  await logActivity(sql, vendor.id, Number(id), kind, body);
  return c.redirect(`/vendor/crm/${id}`, 303);
});

crmRoutes.post('/:id{[0-9]+}/delete', async (c) => {
  const { sql, vendor } = c.var;
  await sql`DELETE FROM crm_contacts WHERE id = ${c.req.param('id')!} AND vendor_id = ${vendor.id}`;
  return c.redirect(withMsg('/vendor/crm', 'Contact deleted.'), 303);
});

// ---- Tasks (mounted at /vendor/tasks) ----

export const taskRoutes = new Hono<VendorEnv>();

taskRoutes.get('/', async (c) => {
  const { sql, vendor } = c.var;
  const showDone = c.req.query('done') === '1';
  const [tasks, contacts] = await sql.transaction([
    sql`SELECT t.id, t.title, t.due_date::text AS due_date, t.done, t.contact_id, ct.name AS contact_name
        FROM crm_tasks t LEFT JOIN crm_contacts ct ON ct.id = t.contact_id
        WHERE t.vendor_id = ${vendor.id} AND t.done = ${showDone}
        ORDER BY t.due_date NULLS LAST, t.id LIMIT 500`,
    sql`SELECT id, name FROM crm_contacts WHERE vendor_id = ${vendor.id} ORDER BY name LIMIT 1000`,
  ]);
  const today = todayUtc();
  return c.html(
    layout(
      'Tasks',
      html`<h1>Tasks</h1>
        <p>${showDone ? html`<a href="/vendor/tasks">Show open</a>` : html`<a href="/vendor/tasks?done=1">Show completed</a>`}</p>
        <table>
          <tr><th></th><th>Task</th><th>Due</th><th>Contact</th></tr>
          ${tasks.map(
            (t) => html`<tr>
              <td><form method="post" action="/vendor/tasks/${t.id}/toggle" class="inline"><button>${t.done ? 'Reopen' : 'Done'}</button></form></td>
              <td>${t.title}</td>
              <td>${t.due_date ? (!t.done && fmtDate(t.due_date) < today ? html`<b style="color:#b00">${fmtDate(t.due_date)} (overdue)</b>` : fmtDate(t.due_date)) : ''}</td>
              <td>${t.contact_id ? html`<a href="/vendor/crm/${t.contact_id}">${t.contact_name}</a>` : ''}</td>
            </tr>`,
          )}
        </table>
        ${tasks.length === 0 ? html`<p class="muted">No ${showDone ? 'completed' : 'open'} tasks.</p>` : ''}
        <h2>New task</h2>
        <form method="post" action="/vendor/tasks" class="stack">
          <label>Task <input name="title" required maxlength="200"></label>
          <label>Due <input name="due_date" type="date"></label>
          <label>Contact <select name="contact_id"><option value="">— none —</option>${options(contacts.map((ct) => ({ value: ct.id, label: ct.name })))}</select></label>
          <button>Add task</button>
        </form>`,
      { vendor, msg: c.req.query('msg'), error: c.req.query('error') },
    ),
  );
});

/** Only allow redirects back to our own vendor pages. */
function safeBack(f: Form, fallback: string): string {
  const back = field(f, 'back', 200);
  return /^\/vendor(\/[a-z0-9/-]*)?$/.test(back) ? back : fallback;
}

taskRoutes.post('/', async (c) => {
  const { sql, vendor } = c.var;
  const f = await c.req.parseBody();
  const title = field(f, 'title', 200);
  const rawDue = field(f, 'due_date');
  const due = rawDue ? parseDate(rawDue) : null;
  const rawContact = field(f, 'contact_id', 20);
  const back = rawContact ? `/vendor/crm/${rawContact.replace(/\D/g, '')}` : '/vendor/tasks';
  if (!title || (rawDue && !due)) return c.redirect(withError(back, 'Task title and a valid due date are required.'), 303);
  let contactId: number | null = null;
  if (rawContact) {
    const [ct] = /^\d+$/.test(rawContact) ? await sql`SELECT id FROM crm_contacts WHERE id = ${rawContact} AND vendor_id = ${vendor.id}` : [];
    if (!ct) return c.notFound();
    contactId = Number(ct.id);
  }
  await sql`INSERT INTO crm_tasks (vendor_id, contact_id, title, due_date) VALUES (${vendor.id}, ${contactId}, ${title}, ${due})`;
  return c.redirect(withMsg(back, 'Task added.'), 303);
});

taskRoutes.post('/:id{[0-9]+}/toggle', async (c) => {
  const { sql, vendor } = c.var;
  const f = await c.req.parseBody();
  await sql`UPDATE crm_tasks SET done = NOT done WHERE id = ${c.req.param('id')!} AND vendor_id = ${vendor.id}`;
  return c.redirect(safeBack(f, '/vendor/tasks'), 303);
});
