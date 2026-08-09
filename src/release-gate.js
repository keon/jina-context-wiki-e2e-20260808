/**
 * Returns whether a release may advance after the required automated checks.
 * The function deliberately treats missing or failed checks as a hard stop.
 */
export function mayPromoteRelease(checks) {
  const required = ["review", "wiki", "causal-graph"];
  const statusByName = new Map(checks.map(({ name, status }) => [name, status]));

  return required.every((name) => statusByName.get(name) === "passed");
}
