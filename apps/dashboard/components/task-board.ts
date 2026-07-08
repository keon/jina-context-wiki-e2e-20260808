export interface TaskBoardItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export function taskBoard(items: readonly TaskBoardItem[]): readonly TaskBoardItem[] {
  return items;
}
