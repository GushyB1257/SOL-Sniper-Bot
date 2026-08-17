/**
 * Fixed-point helpers. All conversions between human decimal strings and base
 * units happen here so rounding behaviour is defined in exactly one place.
 */

const BPS_DENOMINATOR = 10_000n;

/** Parse a human amount ("1.25") into base units for a token with `decimals`. */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`unsupported decimals: ${decimals}`);
  }
  const text = typeof amount === 'number' ? formatNumberExact(amount) : amount.trim();
  if (!/^-?\d*(\.\d*)?$/.test(text) || text === '' || text === '.' || text === '-') {
    throw new TypeError(`not a decimal amount: ${JSON.stringify(amount)}`);
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = unsigned.split('.');

  // Truncate rather than round: over-reporting an input amount we do not have
  // would produce a transaction that fails on-chain.
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  const combined = `${whole || '0'}${paddedFraction}`;
  const value = BigInt(combined === '' ? '0' : combined);
  return negative ? -value : value;
}

/** Render base units as a human decimal string, trimming trailing zeros. */
export function fromBaseUnits(amount: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = amount < 0n;
  const unsigned = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = unsigned / divisor;
  const fraction = unsigned % divisor;

  let fractionText = fraction.toString().padStart(decimals, '0').slice(0, maxFractionDigits);
  fractionText = fractionText.replace(/0+$/, '');

  const body = fractionText === '' ? whole.toString() : `${whole}.${fractionText}`;
  return negative ? `-${body}` : body;
}

/** Ratio of `part` to `whole` in basis points, rounded toward zero. */
export function toBps(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  const scaled = (part * BPS_DENOMINATOR * 1000n) / whole;
  return Number(scaled) / 1000;
}

/** Apply a basis-point haircut, rounding down. */
export function applyBpsDiscount(amount: bigint, bps: number): bigint {
  if (bps <= 0) return amount;
  const bpsInt = BigInt(Math.round(bps));
  return (amount * (BPS_DENOMINATOR - bpsInt)) / BPS_DENOMINATOR;
}

/** Increase an amount by a basis-point margin, rounding up. */
export function applyBpsPremium(amount: bigint, bps: number): bigint {
  if (bps <= 0) return amount;
  const bpsInt = BigInt(Math.round(bps));
  const numerator = amount * (BPS_DENOMINATOR + bpsInt);
  return (numerator + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigintAbs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/**
 * Render a JS number without exponent notation, so `toBaseUnits(1e-7, 9)` does
 * not silently parse the string "1e-7" as garbage.
 */
function formatNumberExact(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`not a finite number: ${value}`);
  if (!/e/i.test(String(value))) return String(value);

  const [mantissa = '0', exponentText = '0'] = String(value).toLowerCase().split('e');
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  const pointIndex = whole.length + exponent;

  let body: string;
  if (pointIndex <= 0) {
    body = `0.${'0'.repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    body = `${digits}${'0'.repeat(pointIndex - digits.length)}`;
  } else {
    body = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return negative ? `-${body}` : body;
}
