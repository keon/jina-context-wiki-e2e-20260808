/**
 * How much the deriving agent writes.
 *
 * Named for what it means to somebody choosing it rather than for the model
 * setting it maps to, so the choice survives a change of model or provider. The
 * mapping to a vendor's own scale lives at the executor boundary.
 *
 * This is a real quality dial rather than cosmetics: the deployed default was
 * the model's terse setting, which is a direct cause of one-paragraph knowledge
 * documents on a task whose output *is* the document.
 */
export const derivationDetailLevels = ["concise", "standard", "thorough"] as const;

export type DerivationDetail = (typeof derivationDetailLevels)[number];

export function isDerivationDetail(value: unknown): value is DerivationDetail {
  return typeof value === "string" && (derivationDetailLevels as readonly string[]).includes(value);
}
