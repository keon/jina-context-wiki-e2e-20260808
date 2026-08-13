const ZONE_BASE_CENTS = Object.freeze({
  domestic: 500,
  international: 1500
});

export function quoteShipping({ subtotalCents, weightGrams, zone }) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new TypeError("subtotalCents must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) {
    throw new TypeError("weightGrams must be a positive safe integer");
  }
  if (typeof zone !== "string" || !Object.hasOwn(ZONE_BASE_CENTS, zone)) {
    throw new TypeError("zone must be domestic or international");
  }

  const baseCents = subtotalCents >= 5000 ? 0 : ZONE_BASE_CENTS[zone];
  const internationalWeightSurcharge =
    zone === "international" ? Math.ceil(weightGrams / 1000) * 75 : 0;

  return {
    currency: "USD",
    amountCents: baseCents + internationalWeightSurcharge,
    freeShippingApplied: baseCents === 0
  };
}
