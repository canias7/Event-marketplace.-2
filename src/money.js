/* Money is stored in whole cents. This turns cents into something a
   person can read:  250000  ->  "$2,500.00" */
function money(cents) {
  const n = Number(cents || 0) / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Splits a booking total into the marketplace's fee and the vendor's
   share. Works in whole cents so nothing is ever lost to rounding:
   the fee is rounded, and the vendor gets exactly the remainder. */
function splitFee(totalCents, feePercent) {
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const fee = Math.round(total * (Number(feePercent) || 0) / 100);
  return { amountCents: total, feeCents: fee, vendorPayoutCents: total - fee };
}

module.exports = { money, splitFee };
