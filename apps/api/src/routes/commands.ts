import type { BoardCommand } from "@jina/board";

export interface CommandRouteInput {
  readonly taskId: string;
  readonly command: BoardCommand;
}

export function acceptCommand(input: CommandRouteInput): CommandRouteInput {
  return input;
}
