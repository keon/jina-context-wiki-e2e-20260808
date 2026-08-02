/**
 * Exact credit math over decimal money strings. Everything here uses BigInt on the
 * digit strings — NEVER parseFloat — so no floating-point rounding can ever affect a
 * persisted or billed amount. Costs arrive as OpenRouter decimal strings in
 * numeric(18,8) columns; subsidy/share rates are numeric(5,4) strings from Postgres.
 */

/** A non-negative decimal parsed into an integer mantissa and its scale (10^scale divisor). */
type Decimal = { mantissa: bigint; scale: number };

/**
 * Parse a non-negative decimal string ("0", "0.00012345", "12.5", "+3") into {mantissa, scale}.
 * Returns undefined for null/undefined/empty/malformed/negative input (callers treat that as 0).
 */
function parseDecimal(value: string | null | undefined): Decimal | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Accept an optional leading '+'. Reject negatives outright: money/shares are non-negative,
  // and a negative slipping through would corrupt a ceil boundary.
  const unsigned = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    return undefined;
  }
  const [intPart, fracPart = ""] = unsigned.split(".");
  const digits = `${intPart}${fracPart}`;
  return { mantissa: BigInt(digits), scale: fracPart.length };
}

/**
 * customer_share = 1 - subsidy, computed exactly and returned as a 4-decimal string
 * (matching numeric(5,4)). subsidy is a decimal string in [0, 1]; e.g. "0.3000" -> "0.7000",
 * "0.0000" -> "1.0000", "1.0000" -> "0.0000". Invalid/absent subsidy -> "1.0000" (no subsidy).
 */
export function customerShareFromSubsidy(subsidyRate: string | null | undefined): string {
  const subsidy = parseDecimal(subsidyRate);
  const scale = 4;
  const denom = 10n ** BigInt(scale);
  if (!subsidy) {
    return "1.0000";
  }
  // Rescale subsidy mantissa to 4 decimals, then share = 1 - subsidy in 4-decimal fixed point.
  const subsidyScaled = rescale(subsidy, scale);
  let shareScaled = denom - subsidyScaled;
  if (shareScaled < 0n) {
    shareScaled = 0n; // clamp: subsidy > 1 is nonsensical, treat share as 0
  }
  return formatFixed(shareScaled, scale);
}

/**
 * Credits charged for one usage row: ceil(cost * customerShare * 100), computed exactly.
 * cost and customerShare are decimal strings. Missing/undefined/blank cost -> 0 credits.
 * The result is a safe integer (credit counts are tiny relative to Number.MAX_SAFE_INTEGER).
 */
export function creditsForCost(cost: string | null | undefined, customerShare: string): number {
  const costDecimal = parseDecimal(cost);
  if (!costDecimal || costDecimal.mantissa === 0n) {
    return 0;
  }
  const shareDecimal = parseDecimal(customerShare);
  if (!shareDecimal || shareDecimal.mantissa === 0n) {
    return 0;
  }
  // value = cost * share * 100
  //       = (costM / 10^costScale) * (shareM / 10^shareScale) * 100
  // numerator / denom with an exact ceil.
  const numerator = costDecimal.mantissa * shareDecimal.mantissa * 100n;
  const denom = 10n ** BigInt(costDecimal.scale + shareDecimal.scale);
  const ceil = (numerator + denom - 1n) / denom; // numerator >= 0, denom > 0
  return Number(ceil);
}

/**
 * FINDING 5: normalize a wire cost literal into a plain, non-negative decimal string, exactly and
 * without ever touching a float. OpenRouter's proxy preserves the numeric literal it received, which
 * may be scientific notation ("1.5e-7") or carry more precision than numeric(18,8) — both of which the
 * old `^\d+(\.\d+)?$` gate rejected outright (400). This accepts:
 *   - a plain decimal: an integer part, optional fractional part;
 *   - optional scientific notation: e/E followed by a signed integer exponent.
 * The mantissa is unsigned (negatives are rejected — money is non-negative); only the exponent may be
 * signed. The exponent is expanded EXACTLY by shifting the decimal point over the mantissa's digit
 * string, so no rounding happens here: we deliberately keep full fractional precision and let the
 * numeric(18,8) column apply its own rounding on insert (truncating here would be lossy). Returns
 * undefined for any malformed input (e.g. "1e", "e7", "NaN", "-1e-7"); callers 400 on undefined.
 *
 * FINDING 3: bound the exponent and the integer magnitude BEFORE expanding, so the arithmetic is
 * structurally incapable of a RangeError (no unbounded "0".repeat) and can never produce a value that
 * would pass validation here only to overflow numeric(18,8) on insert. An |exponent| beyond
 * EXPONENT_EXPANSION_LIMIT, or a normalized integer part exceeding numeric(18,8)'s MAX_INTEGER_DIGITS,
 * is rejected (undefined -> 400). Fractional precision beyond scale 8 is intentionally NOT bounded —
 * it is preserved exactly and the column rounds it on insert.
 */
const EXPONENT_EXPANSION_LIMIT = 30;
const MAX_INTEGER_DIGITS = 10; // numeric(18,8): 18 total - 8 fractional = 10 integer digits.

export function normalizeDecimalLiteral(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  // Unsigned mantissa (int + optional fraction) with an optional signed-integer exponent.
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const intPart = match[1]!;
  const fracPart = match[2] ?? "";
  const exponent = match[3] !== undefined ? Number.parseInt(match[3], 10) : 0;
  // Bound the exponent BEFORE any expansion. A |exponent| this large cannot fit numeric(18,8) and
  // expanding it would allocate a pathological string (or RangeError on "0".repeat); reject as a 400.
  if (Math.abs(exponent) > EXPONENT_EXPANSION_LIMIT) {
    return undefined;
  }
  // The value equals `digits * 10^shift` where digits is the mantissa with the point removed and
  // shift = exponent - (number of fractional digits). All exact integer arithmetic on the digit string.
  const digits = `${intPart}${fracPart}`;
  const shift = exponent - fracPart.length;
  let intDigits: string;
  let fracDigits: string;
  if (shift >= 0) {
    // Whole number: append `shift` zeros. Strip leading zeros but keep at least one digit.
    intDigits = `${digits}${"0".repeat(shift)}`.replace(/^0+(?=\d)/, "");
    fracDigits = "";
  } else {
    // Fractional: place the point `k` digits from the right of the mantissa.
    const k = -shift;
    if (digits.length > k) {
      intDigits = digits.slice(0, digits.length - k);
      fracDigits = digits.slice(digits.length - k);
    } else {
      intDigits = "0";
      fracDigits = digits.padStart(k, "0");
    }
    intDigits = intDigits.replace(/^0+(?=\d)/, "");
  }
  // Reject values whose integer part overflows numeric(18,8)'s 10 integer digits — these would pass
  // the regex but fail the column insert (5xx retry loop), the exact failure this validator prevents.
  if (intDigits.length > MAX_INTEGER_DIGITS) {
    return undefined;
  }
  return fracDigits.length > 0 ? `${intDigits}.${fracDigits}` : intDigits;
}

/**
 * Sum two non-negative decimal money strings EXACTLY, with no float ever touching the digits.
 * Used for the BYOK billing basis: billable_cost = upstream_inference_cost + cost. Each argument is
 * parsed into {mantissa, scale}; a null/undefined/blank/malformed/negative operand is treated as 0
 * (matching parseDecimal's contract and the numeric columns' nullable-as-zero semantics). The two
 * operands are aligned to the wider scale, added as BigInts, and formatted back to a plain decimal
 * string. Full fractional precision is preserved (no rounding here — the numeric(18,8) column rounds
 * on insert exactly as it does for the raw cost fields). Returns "0" when both operands are absent.
 */
export function exactDecimalSum(a: string | null | undefined, b: string | null | undefined): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (!left && !right) {
    return "0";
  }
  const scale = Math.max(left?.scale ?? 0, right?.scale ?? 0);
  const leftM = left ? rescale({ mantissa: left.mantissa, scale: left.scale }, scale) : 0n;
  const rightM = right ? rescale({ mantissa: right.mantissa, scale: right.scale }, scale) : 0n;
  const sum = leftM + rightM;
  if (scale === 0) {
    return sum.toString();
  }
  return formatFixed(sum, scale);
}

/**
 * Multiply a non-negative decimal money string by 10^power EXACTLY (shifts the decimal point; never a
 * float). Used to turn OpenRouter's per-token pricing strings into per-1,000,000-token prices
 * (power = 6). Returns undefined for null/undefined/blank/malformed/negative input so callers can render
 * a null price. Full precision is preserved: e.g. "0.0000005" * 10^6 -> "0.5", "0.0000032" -> "3.2".
 */
export function multiplyDecimalStringByPowerOfTen(value: string | null | undefined, power: number): string | undefined {
  const decimal = parseDecimal(value);
  if (!decimal) {
    return undefined;
  }
  const newScale = decimal.scale - power;
  if (newScale <= 0) {
    // The value has no fractional part after the shift: scale the mantissa up and print as an integer.
    const scaled = decimal.mantissa * 10n ** BigInt(-newScale);
    return scaled.toString();
  }
  return formatFixed(decimal.mantissa, newScale);
}

/** Rescale a Decimal to exactly `scale` fractional digits (truncating any extra precision). */
function rescale(decimal: Decimal, scale: number): bigint {
  if (decimal.scale === scale) {
    return decimal.mantissa;
  }
  if (decimal.scale < scale) {
    return decimal.mantissa * 10n ** BigInt(scale - decimal.scale);
  }
  return decimal.mantissa / 10n ** BigInt(decimal.scale - scale);
}

/** Format a fixed-point mantissa (with `scale` fractional digits) as a decimal string. */
function formatFixed(mantissa: bigint, scale: number): string {
  const digits = mantissa.toString().padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  return `${intPart}.${fracPart}`;
}
