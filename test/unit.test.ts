import { describe, expect, it } from 'vitest';
import { hashPassword, hmacSha256Hex, verifyPassword } from '../src/lib/auth';
import { requireTestKey, verifyWebhookSignature } from '../src/lib/stripe';
import { parseDate, parseMoney, platformFee, slugify } from '../src/lib/util';

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong horse', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('stripe', () => {
  it('only accepts test keys', () => {
    expect(requireTestKey('sk_test_abc')).toBe('sk_test_abc');
    expect(() => requireTestKey('sk_live_abc')).toThrow(/live/);
    expect(() => requireTestKey(undefined)).toThrow(/not configured/);
  });

  it('verifies webhook signatures', async () => {
    const payload = '{"id":"evt_1"}';
    const t = 1_700_000_000;
    const sig = await hmacSha256Hex('whsec_x', `${t}.${payload}`);
    expect(await verifyWebhookSignature(payload, `t=${t},v1=${sig}`, 'whsec_x', 300, t + 10)).toBe(true);
    expect(await verifyWebhookSignature(payload, `t=${t},v1=${sig}`, 'whsec_other', 300, t)).toBe(false);
    expect(await verifyWebhookSignature(payload + ' ', `t=${t},v1=${sig}`, 'whsec_x', 300, t)).toBe(false);
    expect(await verifyWebhookSignature(payload, `t=${t},v1=${sig}`, 'whsec_x', 300, t + 1000)).toBe(false);
    expect(await verifyWebhookSignature(payload, undefined, 'whsec_x')).toBe(false);
  });
});

describe('util', () => {
  it('parses money', () => {
    expect(parseMoney('1,250.50')).toBe(125050);
    expect(parseMoney('$99')).toBe(9900);
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
  it('parses dates', () => {
    expect(parseDate('2027-02-28')).toBe('2027-02-28');
    expect(parseDate('2027-02-30')).toBeNull();
    expect(parseDate('tomorrow')).toBeNull();
  });
  it('computes platform fee', () => {
    expect(platformFee(10000, '1000')).toBe(1000);
    expect(platformFee(10000, undefined)).toBe(1000);
    expect(platformFee(10000, 'nonsense')).toBe(1000);
    expect(platformFee(999, '250')).toBe(25);
  });
  it('slugifies', () => {
    expect(slugify("Lens & Light Photography!")).toBe('lens-light-photography');
    expect(slugify('***')).toBe('vendor');
  });
});
