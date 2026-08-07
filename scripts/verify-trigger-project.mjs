const apiUrl = (process.env.TRIGGER_API_URL ?? "https://api.trigger.dev").replace(/\/$/, "");
const accessToken = process.env.TRIGGER_ACCESS_TOKEN?.trim();
const projectRef = process.env.TRIGGER_PROJECT_REF?.trim();
const expectedName = process.env.EXPECTED_TRIGGER_PROJECT_NAME?.trim();
const expectedOrganizationSlug = process.env.EXPECTED_TRIGGER_ORGANIZATION_SLUG?.trim();

for (const [name, value] of Object.entries({
  TRIGGER_ACCESS_TOKEN: accessToken,
  TRIGGER_PROJECT_REF: projectRef,
  EXPECTED_TRIGGER_PROJECT_NAME: expectedName,
  EXPECTED_TRIGGER_ORGANIZATION_SLUG: expectedOrganizationSlug
})) {
  if (!value) throw new Error(`${name} is required`);
}

const response = await fetch(`${apiUrl}/api/v1/projects/${encodeURIComponent(projectRef)}`, {
  headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
});
if (!response.ok) {
  throw new Error(`Trigger project identity lookup failed with status ${response.status}`);
}
const body = await response.json();
if (!body || typeof body !== "object" || Array.isArray(body)) {
  throw new Error("Trigger project identity lookup returned a malformed response");
}
const project = body;
if (project.externalRef !== projectRef || project.name !== expectedName) {
  throw new Error("Trigger project identity does not match the pinned deployment target");
}
if (
  !project.organization ||
  typeof project.organization !== "object" ||
  Array.isArray(project.organization) ||
  project.organization.slug !== expectedOrganizationSlug
) {
  throw new Error("Trigger project organization does not match the pinned deployment target");
}
console.log(`Verified Trigger project ${project.externalRef} (${project.name}) in ${project.organization.slug}`);
