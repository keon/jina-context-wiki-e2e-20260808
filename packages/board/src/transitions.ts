import type { TaskStatus } from "./task-status.js";
import type { TaskType } from "./tasks.js";

export type TransitionActorType = "system" | "reducer" | "run" | "user" | "github";

interface TransitionRule {
  readonly from: readonly TaskStatus[];
  readonly to: readonly TaskStatus[];
  readonly actors: readonly TransitionActorType[];
}

const activeStatuses: readonly TaskStatus[] = ["triage", "queued", "in_progress", "blocked", "failed"];

const dispatchableRules: readonly TransitionRule[] = [
  { from: ["triage", "blocked"], to: ["queued"], actors: ["reducer", "system"] },
  { from: ["triage", "queued"], to: ["blocked"], actors: ["reducer", "system"] },
  { from: ["queued"], to: ["in_progress"], actors: ["run", "reducer"] },
  { from: ["in_progress"], to: ["done", "blocked", "failed"], actors: ["run"] },
  { from: activeStatuses, to: ["superseded"], actors: ["system", "github"] },
  { from: activeStatuses, to: ["canceled"], actors: ["user", "system"] }
];

const transitionRules: Partial<Record<TaskType, readonly TransitionRule[]>> = {
  pr_review: [
    { from: ["triage", "blocked"], to: ["done", "blocked"], actors: ["reducer", "system"] },
    { from: ["triage", "blocked"], to: ["superseded"], actors: ["system", "github"] },
    { from: ["triage", "blocked"], to: ["canceled"], actors: ["user", "system"] }
  ],
  review_pass: dispatchableRules,
  context: dispatchableRules,
  publish: dispatchableRules,
  cleanup: dispatchableRules,
  issue_triage: [
    { from: ["triage"], to: ["in_progress", "done", "canceled"], actors: ["user", "system"] },
    { from: ["in_progress"], to: ["done", "canceled"], actors: ["user", "system"] }
  ],
  human_decision: [
    { from: ["triage"], to: ["blocked"], actors: ["system", "reducer"] },
    { from: ["blocked"], to: ["done", "canceled"], actors: ["user"] },
    { from: ["triage", "blocked"], to: ["superseded"], actors: ["system", "github"] }
  ]
};

export function canTransition(type: TaskType, from: TaskStatus, to: TaskStatus, actor: TransitionActorType): boolean {
  return (transitionRules[type] ?? dispatchableRules).some(
    (rule) => rule.from.includes(from) && rule.to.includes(to) && rule.actors.includes(actor)
  );
}
