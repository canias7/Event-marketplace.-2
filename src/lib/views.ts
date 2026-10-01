import { html, raw } from 'hono/html';
import type { Vendor } from '../types';

export type Html = ReturnType<typeof html>;

const CSS = `
body{font-family:system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:0 16px 48px;color:#222;line-height:1.45}
header{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;border-bottom:1px solid #ddd;padding:12px 0;margin-bottom:16px}
header nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
a{color:#0645ad}
table{border-collapse:collapse;width:100%;margin:8px 0 16px}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f5f5f5}
form.stack{display:grid;gap:8px;max-width:520px}
form.inline{display:inline}
label{display:grid;gap:2px;font-size:14px}
input,select,textarea{font:inherit;padding:6px;border:1px solid #bbb;border-radius:4px}
textarea{min-height:80px}
button{font:inherit;padding:6px 12px;cursor:pointer}
.flash{background:#eef6ee;border:1px solid #9c9;padding:8px}
.error{background:#fbeaea;border:1px solid #d99;padding:8px}
.muted{color:#666;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{border:1px solid #ddd;border-radius:6px;padding:12px}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;background:#eee;font-size:13px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
@media (max-width:760px){.cols{grid-template-columns:1fr}}
`;

export function layout(
  title: string,
  body: Html | Html[],
  opts: { vendor?: Vendor | null; msg?: string; error?: string } = {},
): Html {
  const nav = opts.vendor
    ? html`<a href="/vendor">Dashboard</a>
        <a href="/vendor/crm">CRM</a>
        <a href="/vendor/tasks">Tasks</a>
        <a href="/vendor/bookings">Bookings</a>
        <a href="/vendor/services">Services</a>
        <a href="/vendor/payments">Payments</a>
        <a href="/vendor/profile">Profile</a>
        <form method="post" action="/logout" class="inline"><button>Log out</button></form>`
    : html`<a href="/login">Vendor login</a> <a href="/signup">List your business</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · EventVendora</title>
<style>${raw(CSS)}</style>
</head>
<body>
<header><a href="/"><b>EventVendora Marketplace</b></a><nav>${nav}</nav></header>
<main>
${opts.msg ? html`<p class="flash">${opts.msg}</p>` : ''}
${opts.error ? html`<p class="error">${opts.error}</p>` : ''}
${body}
</main>
</body>
</html>`;
}

export function options(values: readonly (string | { value: string | number; label: string })[], selected?: string | number | null): Html[] {
  return values.map((v) => {
    const value = typeof v === 'string' ? v : String(v.value);
    const label = typeof v === 'string' ? v : v.label;
    return html`<option value="${value}" ${String(selected ?? '') === value ? 'selected' : ''}>${label}</option>`;
  });
}
