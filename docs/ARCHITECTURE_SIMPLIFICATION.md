# Architecture simplification

This repository has one target runtime: a single API listener, relational
review/control Board, page-oriented Context Board, specialized workers, and one
tenant-scoped customer dashboard. Compatibility code is allowed only where a
persisted queue or production deployment still proves it is needed.

## Completed in this pass

- Removed the unused local workflow application and its isolated Context,
  policy, publication, and AI workspaces. Review experiments now use the same
  `@jina/review-agent` implementation as deployed workers.
- Folded the persisted legacy review planner into `apps/api` and its legacy
  execution contract into `apps/worker`. This makes the compatibility surface
  local and deletes five package boundaries without pretending the live queue
  has drained.
- Made queue topics a wire contract in `@jina/shared-kernel`. API admission,
  Context workflow definitions, worker validation, and acceptance checks now
  consume those declarations.
- Replaced worker dispatch branching with an exhaustive handler registry. The
  old internal Context stage topics are implementation calls, not claimable
  queue routes.
- Made relational review/control work the task worker default. Claiming
  `run-review` now requires the explicit
  `JINA_LEGACY_REVIEW_PIPELINE_ENABLED=true` compatibility gate.
- Reused the API's existing PostgreSQL pool for the JSON Board state and product
  API. The combined process no longer opens independent state and product pools;
  standalone migration commands retain their own connection lifecycle. The
  shared-identity reader keeps its separate read-only security boundary.

## Boundaries retained deliberately

- `apps/admin` remains separate because it is a privileged operational surface,
  not a customer-dashboard route.
- Next.js `src/app/**/page.tsx` adapters remain because they are framework route
  entries. Moving feature implementations into them would save no runtime code
  and would couple feature modules to the router.
- Context artifacts remain in object storage while relational tables retain
  workflow/index metadata. Large immutable artifacts and transactional state
  have different storage requirements.
- `@jina/review-agent` remains separate from the worker host so the same portable
  runtime can execute and be evaluated in isolation.

## Required live-data cutovers

These are not safe source-only deletions. Perform each under a release lease,
record the evidence, and delete its compatibility module in the immediately
following release.

### Review queue

1. Apply product and relational Board migrations in production.
2. Enable the product API and route the signed GitHub webhook to its admission
   handler.
3. Deploy the six review topics plus the two control topics.
4. Verify that no non-terminal JSON Board `review_pass` task and no leased or
   pending `run-review` outbox message remains.
5. Remove `JINA_LEGACY_REVIEW_PIPELINE_ENABLED`,
   `apps/api/src/legacy-review-pipeline.ts`,
   `apps/worker/src/legacy-review-contract.ts`, and the `run-review` handler.

### Context Board state

The page-oriented Context contract is already the only admission and claim path.
Six legacy stage implementations remain embedded behind durable phase
checkpoints inside the four page-oriented task kinds. Five unclaimable executors,
their helper island, and the permanently skipped fixtures for the obsolete
multi-stage queue topology were removed in this pass. The old detailed Board
reducer remains only to interpret and retire persisted snapshots; this source
tree cannot resume its internal queue topics.

1. Before deploying this source, verify every non-terminal Context build uses
   the page-oriented contract and schema revision; otherwise finish or cancel it
   with the currently deployed worker first.
2. Verify no pending or leased outbox message contains an internal Context stage
   topic.
3. Extract the six still-embedded stage contracts from `workflow/board.ts`.
4. Delete the old graph constructors, result reducer, repair/recovery branches,
   and their remaining snapshot-compatibility tests.

### JSON Board to relational Board

Do not replace the JSON snapshot with direct relational writes in one release.
Add a shadow projection, compare task/dependency/outbox state at every mutation,
then switch reads only after a full release reports zero divergence. Context
publication transactions currently lock the JSON snapshot together with release
metadata, so their atomicity must move with the cutover.

### Dashboard routes and transition tooling

Tenant-scoped routes are authoritative. Viewer-scoped routes remain for local
fixtures and deploy skew; database/identity transition commands remain operator
rollback tools. Remove them only after the oldest supported dashboard release no
longer calls them and the production cutover record confirms rollback is no
longer permitted. This is an operational retention rule, not a second target
architecture.

## Remaining pressure points

1. The JSON Board snapshot still serializes unrelated workflow mutations through
   one row and one advisory lock. Pool consolidation reduces connections, not
   lock contention; the shadow relational cutover above is the scalability fix.
2. The collapsed planner checkpoints several subject-research calls inside one
   lease and currently executes them sequentially. Bounded parallelism would
   reduce latency only after quota reservation and usage receipts become
   per-subject; parallelizing first would weaken cost and failure accounting.
3. `apps/api/src/server.ts` and `apps/worker/src/server.ts` remain large because
   they still contain both target-runtime and compatibility behavior. Split by
   route or handler ownership when the compatibility cutovers remove real code;
   moving the same code into more files now would change navigation, not system
   complexity.
4. `context-board-quality-v2` and part of the chaos manifest still validate
   retired source-challenge, task-evaluation, and standalone certification
   artifacts. Their documentation now marks that scope. Replace those checks
   with page-disposition and integrated-publication assertions before treating
   either harness as a page-oriented release gate.
