/**
 * Immutable request identity shared by review admission and the task-worker
 * Trigger.dev bridge. Keeping this in one package prevents a worker release
 * from silently calculating a different receipt digest than the API release
 * that admitted the task.
 */
export function canonicalReviewTriggerRequest(input: {
  readonly taskIdentifier: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
}): string {
  return canonicalJson({
    trigger_task_id: input.taskIdentifier,
    trigger_payload: input.payload,
    trigger_options: input.options
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      // Unicode code-unit ordering is runtime-locale independent. A digest
      // must not change when API and worker containers use different locales.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON cannot encode undefined");
  return encoded;
}
