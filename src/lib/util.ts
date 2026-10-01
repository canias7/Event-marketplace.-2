export type Form = Record<string, string | File | (string | File)[]>;

/** Reads a trimmed string field from a parsed form, truncated to max characters. */
export function field(form: Form, name: string, max = 500): string {
  const v = form[name];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

/** Returns a YYYY-MM-DD string if valid, otherwise null. */
export function parseDate(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parses "1,250.50" or "1250" into cents. Returns null if invalid. */
export function parseMoney(s: string): number | null {
  const clean = s.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}

export function money(cents: number | string | null | undefined): string {
  const n = Number(cents ?? 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '';
  const iso = typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'vendor'
  );
}

export function platformFee(amountCents: number, bps: string | undefined): number {
  const rate = Number(bps ?? 1000);
  const safe = Number.isFinite(rate) && rate >= 0 && rate <= 5000 ? rate : 1000;
  return Math.round((amountCents * safe) / 10_000);
}

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const CRM_STAGES = ['lead', 'contacted', 'proposal', 'booked', 'completed', 'lost'] as const;
export type CrmStage = (typeof CRM_STAGES)[number];
export const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting'] as const;

export function withMsg(path: string, msg: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;
}

export function randomSuffix(): string {
  return [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 5);
}

export function withError(path: string, error: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}`;
}
