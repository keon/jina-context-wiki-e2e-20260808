import { ContextWikiApiClient } from "../shared/api.js";
import { type WikiStageName, type WikiStageResult, parseWikiStageTaskPayload } from "../shared/contracts.js";

export async function runContextWikiStage(
  stage: WikiStageName,
  payload: unknown,
  api: Pick<ContextWikiApiClient, "runStage"> = new ContextWikiApiClient()
): Promise<WikiStageResult> {
  const parsed = parseWikiStageTaskPayload(payload);
  const result = await api.runStage({
    authorityId: parsed.authorityId,
    stage,
    executionGrant: parsed.executionGrant,
    operationId: parsed.operationId,
    stageInput: parsed.input
  });
  if (result.operationId !== parsed.operationId) {
    throw new Error(`${stage} response operationId does not match request`);
  }
  return result;
}
