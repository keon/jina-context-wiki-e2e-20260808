import type { ContextGraphAssertion } from "./types.ts";

/** Rendering-friendly view of either flat or nested API assertion shapes. */
export interface AssertionView {
  readonly subjectLabel: string;
  readonly subjectKind: string;
  readonly objectLabel: string;
  readonly objectKind: string;
  readonly generator: string;
  readonly supportingAssertionIds: readonly string[];
  readonly contradictingAssertionIds: readonly string[];
}

export function assertionView(assertion: ContextGraphAssertion): AssertionView {
  const subject = assertion.subject as { readonly kind?: string; readonly label?: string } | undefined;
  const object = assertion.object as { readonly kind?: string; readonly label?: string } | undefined;
  return {
    subjectLabel: stringValue(assertion.subjectLabel) || subject?.label || "",
    subjectKind: stringValue(assertion.subjectKind) || subject?.kind || "",
    objectLabel: stringValue(assertion.objectLabel) || object?.label || "",
    objectKind: stringValue(assertion.objectKind) || object?.kind || "",
    generator: stringValue(assertion.generator),
    supportingAssertionIds: stringList(assertion.supportingAssertionIds),
    contradictingAssertionIds: stringList(assertion.contradictingAssertionIds)
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export const ASSERTION_REJECTION_CODES: readonly (readonly [string, string])[] = [
  ["", "Rejection category"],
  ["incorrect_relationship", "Incorrect relationship"],
  ["insufficient_evidence", "Insufficient evidence"],
  ["unsupported_explanation", "Unsupported explanation"],
  ["other", "Other"]
];
