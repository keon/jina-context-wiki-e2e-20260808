"use server";

import { redirect } from "next/navigation";
import { startGraphBuild } from "../../lib/jina-api";

export async function createGraphBuild(formData: FormData): Promise<never> {
  const tenantId = requiredField(formData, "tenantId");
  const repository = requiredField(formData, "repository");
  const ref = requiredField(formData, "ref");
  const installationValue = Number(requiredField(formData, "githubInstallationId"));
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(tenantId)) throw new Error("Invalid tenant ID");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("Repository must use owner/name format");
  if (!Number.isSafeInteger(installationValue) || installationValue <= 0) {
    throw new Error("GitHub installation ID must be a positive integer");
  }
  const result = await startGraphBuild({
    tenantId,
    repository,
    ref,
    githubInstallationId: installationValue
  });
  redirect(`/history?q=${encodeURIComponent(result.task.id)}`);
}

function requiredField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
