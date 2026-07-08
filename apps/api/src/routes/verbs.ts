import type { BoardVerb } from "@jina/board";

export interface VerbRouteCommand {
  readonly taskId: string;
  readonly verb: BoardVerb;
}

export function acceptVerbCommand(command: VerbRouteCommand): VerbRouteCommand {
  return command;
}
