import assert from "node:assert/strict";
import { test } from "node:test";

import {
  creditsForCost,
  customerShareFromSubsidy,
  exactDecimalSum,
  multiplyDecimalStringByPowerOfTen,
  normalizeDecimalLiteral,
} from "./billing-math.js";

/* --------------------------------------------------------- creditsForCost --- */

test("creditsForCost applies the spec ceil boundary: $0.01 at 0.70 share => 1 credit", () => {
  // 0.01 * 0.70 * 100 = 0.70 -> ceil = 1
  assert.equal(creditsForCost("0.01", "0.7000"), 1);
});

test("creditsForCost is exact on whole-credit boundaries (no float over-rounding)", () => {
  // 0.01 * 1.0 * 100 = 1.0 exactly -> ceil = 1 (must NOT round up to 2)
  assert.equal(creditsForCost("0.01", "1.0000"), 1);
  // 50 * 0.70 * 100 = 3500 exactly
  assert.equal(creditsForCost("50", "0.7000"), 3500);
});

test("creditsForCost matches the spec example (~$27.50 at 30% subsidy => 1925 AI credits)", () => {
  // 27.50 * 0.70 * 100 = 1925 exactly (the +100 infra is added separately)
  assert.equal(creditsForCost("27.50", "0.7000"), 1925);
});

test("creditsForCost ceils high-precision costs", () => {
  // 0.00012345 * 1.0 * 100 = 0.012345 -> ceil = 1
  assert.equal(creditsForCost("0.00012345", "1.0000"), 1);
  // 0.033 * 1.0 * 100 = 3.3 -> ceil = 4
  assert.equal(creditsForCost("0.033", "1.0000"), 4);
});

test("creditsForCost returns 0 for zero, missing, blank, or malformed cost", () => {
  assert.equal(creditsForCost("0", "0.7000"), 0);
  assert.equal(creditsForCost("0.00000000", "0.7000"), 0);
  assert.equal(creditsForCost(undefined, "0.7000"), 0);
  assert.equal(creditsForCost(null, "0.7000"), 0);
  assert.equal(creditsForCost("", "0.7000"), 0);
  assert.equal(creditsForCost("  ", "0.7000"), 0);
  assert.equal(creditsForCost("not-a-number", "0.7000"), 0);
});

test("creditsForCost never bills a negative cost (guards against corruption)", () => {
  assert.equal(creditsForCost("-0.01", "0.7000"), 0);
});

test("creditsForCost returns 0 when the share is zero (full subsidy)", () => {
  assert.equal(creditsForCost("50", "0.0000"), 0);
});

test("creditsForCost passes cost through at share 1.0 (overage, no subsidy)", () => {
  // 0.12345678 * 1.0 * 100 = 12.345678 -> ceil = 13
  assert.equal(creditsForCost("0.12345678", "1.0000"), 13);
});

test("creditsForCost tolerates share strings of differing scales", () => {
  // 0.10 * 0.5 * 100 = 5 exactly
  assert.equal(creditsForCost("0.10", "0.5"), 5);
});

/* ---------------------------------------- normalizeDecimalLiteral (FINDING 5) --- */

test("normalizeDecimalLiteral passes plain decimal strings through unchanged", () => {
  assert.equal(normalizeDecimalLiteral("0"), "0");
  assert.equal(normalizeDecimalLiteral("12"), "12");
  assert.equal(normalizeDecimalLiteral("0.0123"), "0.0123");
  assert.equal(normalizeDecimalLiteral("1.5"), "1.5");
  assert.equal(normalizeDecimalLiteral("0.00012345"), "0.00012345");
});

test("normalizeDecimalLiteral expands negative exponents exactly (no float)", () => {
  assert.equal(normalizeDecimalLiteral("1e-7"), "0.0000001");
  assert.equal(normalizeDecimalLiteral("1.5e-7"), "0.00000015");
  assert.equal(normalizeDecimalLiteral("2.5E-6"), "0.0000025");
  assert.equal(normalizeDecimalLiteral("5e-1"), "0.5");
  // A tiny literal keeps FULL precision — numeric(18,8) applies its own rounding on insert.
  assert.equal(normalizeDecimalLiteral("1.23456789012e-2"), "0.0123456789012");
});

test("normalizeDecimalLiteral expands positive/zero exponents exactly", () => {
  assert.equal(normalizeDecimalLiteral("1e2"), "100");
  assert.equal(normalizeDecimalLiteral("1e+3"), "1000");
  assert.equal(normalizeDecimalLiteral("1.23456789012e2"), "123.456789012");
  assert.equal(normalizeDecimalLiteral("1.5e0"), "1.5");
  assert.equal(normalizeDecimalLiteral("2.5e1"), "25");
  // Point lands exactly at the end of the mantissa digits.
  assert.equal(normalizeDecimalLiteral("1.23e2"), "123");
});

test("normalizeDecimalLiteral strips redundant leading zeros but keeps at least one digit", () => {
  assert.equal(normalizeDecimalLiteral("0.5e1"), "5");
  assert.equal(normalizeDecimalLiteral("0e5"), "0");
  assert.equal(normalizeDecimalLiteral("00.5"), "0.5");
});

test("normalizeDecimalLiteral rejects negatives, malformed exponents, and non-numbers", () => {
  assert.equal(normalizeDecimalLiteral("-1e-7"), undefined);
  assert.equal(normalizeDecimalLiteral("-0.5"), undefined);
  assert.equal(normalizeDecimalLiteral("+0.5"), undefined);
  assert.equal(normalizeDecimalLiteral("1e"), undefined);
  assert.equal(normalizeDecimalLiteral("e7"), undefined);
  assert.equal(normalizeDecimalLiteral("NaN"), undefined);
  assert.equal(normalizeDecimalLiteral("Infinity"), undefined);
  assert.equal(normalizeDecimalLiteral("1.5e1.5"), undefined);
  assert.equal(normalizeDecimalLiteral(".5"), undefined);
  assert.equal(normalizeDecimalLiteral("1."), undefined);
  assert.equal(normalizeDecimalLiteral(""), undefined);
  assert.equal(normalizeDecimalLiteral("  "), undefined);
  assert.equal(normalizeDecimalLiteral(null), undefined);
  assert.equal(normalizeDecimalLiteral(undefined), undefined);
});

// FINDING 3: bound the exponent/integer magnitude BEFORE expansion so an extreme literal can never
// RangeError during validation (5xx retry loop) or pass validation then overflow numeric(18,8).
test("normalizeDecimalLiteral rejects an extreme exponent without a RangeError", () => {
  assert.equal(normalizeDecimalLiteral("1e100000"), undefined); // would blow up "0".repeat pre-fix
  assert.equal(normalizeDecimalLiteral("1e31"), undefined); // |exponent| > 30
  assert.equal(normalizeDecimalLiteral("1e-31"), undefined);
});

test("normalizeDecimalLiteral rejects a value whose integer part overflows numeric(18,8)", () => {
  assert.equal(normalizeDecimalLiteral("99999999999"), undefined); // 11 integer digits
  assert.equal(normalizeDecimalLiteral("1e10"), undefined); // 10000000000 -> 11 integer digits
});

test("normalizeDecimalLiteral accepts values at the numeric(18,8) bounds", () => {
  assert.equal(normalizeDecimalLiteral("1e-30"), "0.000000000000000000000000000001"); // |exponent| == 30
  assert.equal(normalizeDecimalLiteral("9999999999"), "9999999999"); // exactly 10 integer digits
});

test("normalizeDecimalLiteral output is always accepted by creditsForCost (compatibility)", () => {
  // 1.5e-7 * 1.0 * 100 = 0.000015 -> ceil = 1 credit
  assert.equal(creditsForCost(normalizeDecimalLiteral("1.5e-7"), "1.0000"), 1);
  // 27.5e0 at 30% subsidy matches the spec example exactly.
  assert.equal(creditsForCost(normalizeDecimalLiteral("2.750e1"), "0.7000"), 1925);
  // Plain literal passthrough still works end to end.
  assert.equal(creditsForCost(normalizeDecimalLiteral("0.01"), "0.7000"), 1);
});

/* ------------------------------------------------ customerShareFromSubsidy --- */

test("customerShareFromSubsidy computes 1 - subsidy at 4 decimals", () => {
  assert.equal(customerShareFromSubsidy("0.3000"), "0.7000");
  assert.equal(customerShareFromSubsidy("0.0000"), "1.0000");
  assert.equal(customerShareFromSubsidy("1.0000"), "0.0000");
});

test("customerShareFromSubsidy rescales lower-precision subsidy strings", () => {
  assert.equal(customerShareFromSubsidy("0.30"), "0.7000");
  assert.equal(customerShareFromSubsidy("0.5"), "0.5000");
});

test("customerShareFromSubsidy defaults to full share (1.0000) on missing/blank input", () => {
  assert.equal(customerShareFromSubsidy(undefined), "1.0000");
  assert.equal(customerShareFromSubsidy(null), "1.0000");
  assert.equal(customerShareFromSubsidy(""), "1.0000");
});

test("customerShareFromSubsidy clamps a nonsensical subsidy > 1 to a zero share", () => {
  assert.equal(customerShareFromSubsidy("2.0000"), "0.0000");
});

test("customerShareFromSubsidy composes with creditsForCost at platform defaults", () => {
  // Full managed run AI portion at 30% subsidy: 50 * (1-0.30) * 100 = 3500
  const share = customerShareFromSubsidy("0.3000");
  assert.equal(creditsForCost("50", share), 3500);
});

/* -------------------------------------------------- exactDecimalSum (BYOK basis) --- */

test("exactDecimalSum sums the BYOK basis exactly: $0.05 fee + $1.00 upstream => 1.05 => 74 credits", () => {
  const basis = exactDecimalSum("1.00", "0.05");
  assert.equal(basis, "1.05");
  // The whole point: bill from the summed basis, not the $0.05 fee alone. ceil(1.05*0.70*100)=74.
  assert.equal(creditsForCost(basis, "0.7000"), 74);
});

test("exactDecimalSum aligns differing scales without float error", () => {
  // Operands are plain decimal strings (already normalized by optionalDecimalString before this runs).
  assert.equal(exactDecimalSum("0.00012345", "1.0"), "1.00012345");
  assert.equal(exactDecimalSum("0.00000015", "0.00000005"), "0.00000020");
  assert.equal(exactDecimalSum("0.1", "0.2"), "0.3"); // the classic float trap, exact here
});

test("exactDecimalSum treats null/undefined/blank/malformed operands as zero", () => {
  assert.equal(exactDecimalSum(undefined, "0.05"), "0.05");
  assert.equal(exactDecimalSum("1.00", null), "1.00");
  assert.equal(exactDecimalSum("", "0.05"), "0.05");
  assert.equal(exactDecimalSum("not-a-number", "0.05"), "0.05");
  assert.equal(exactDecimalSum(null, undefined), "0");
});

test("exactDecimalSum ignores a negative operand (money is non-negative) rather than subtracting", () => {
  // parseDecimal rejects negatives -> treated as 0, so the sum is just the valid operand.
  assert.equal(exactDecimalSum("-1.00", "0.05"), "0.05");
});

test("exactDecimalSum on two integers stays integer-formatted", () => {
  assert.equal(exactDecimalSum("2", "3"), "5");
});

/* ------------------------------- multiplyDecimalStringByPowerOfTen (per-1M pricing) --- */

test("multiplyDecimalStringByPowerOfTen converts OpenRouter per-token prices to per-1M exactly", () => {
  // $0.0000005/token * 1e6 = $0.5 / 1M tokens
  assert.equal(multiplyDecimalStringByPowerOfTen("0.0000005", 6), "0.5");
  // $0.0000032/token -> $3.2 / 1M
  assert.equal(multiplyDecimalStringByPowerOfTen("0.0000032", 6), "3.2");
  // $0.000015/token -> $15 / 1M (scale 6 exactly -> integer)
  assert.equal(multiplyDecimalStringByPowerOfTen("0.000015", 6), "15");
});

test("multiplyDecimalStringByPowerOfTen keeps sub-cent precision (no float rounding)", () => {
  // $0.00000012345/token -> 0.12345 / 1M — the extra fractional digits are preserved exactly
  assert.equal(multiplyDecimalStringByPowerOfTen("0.00000012345", 6), "0.12345");
  // zero stays zero
  assert.equal(multiplyDecimalStringByPowerOfTen("0", 6), "0");
  assert.equal(multiplyDecimalStringByPowerOfTen("0.0", 6), "0");
});

test("multiplyDecimalStringByPowerOfTen is null-safe on absent/malformed/negative input", () => {
  assert.equal(multiplyDecimalStringByPowerOfTen(undefined, 6), undefined);
  assert.equal(multiplyDecimalStringByPowerOfTen(null, 6), undefined);
  assert.equal(multiplyDecimalStringByPowerOfTen("", 6), undefined);
  assert.equal(multiplyDecimalStringByPowerOfTen("abc", 6), undefined);
  assert.equal(multiplyDecimalStringByPowerOfTen("-0.0000005", 6), undefined);
});
