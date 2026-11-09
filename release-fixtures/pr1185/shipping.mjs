export function shippingCents(subtotalCents) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new TypeError('subtotalCents must be a nonnegative safe integer');
  }
  return subtotalCents > 5_000 ? 0 : 499;
}
