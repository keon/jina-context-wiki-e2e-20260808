# Capy-inspired onboarding plan

Status: implemented
Owner: Dashboard / Product API
Target: staging

## Outcome

Give a newly created Jina account a calm, full-screen setup flow that turns an authenticated user into a workspace that can do useful work. The experience should borrow Capy's strongest interaction patterns—one decision per screen, explicit progress, persistent back/skip controls, real integration handoffs, and a final set of useful starting points—while using Jina's own visual language and product model.

The team flow is successful when a new user can:

1. choose a personal or shared workspace;
2. create or select a Jina organization when working with a team;
3. state the first job they want Jina to do;
4. install the Jina GitHub App for the selected workspace;
5. choose the automatic review policy that will actually be saved for that workspace;
6. connect Codex, or deliberately continue without it;
7. invite teammates when the workspace is shared; and
8. land on the most relevant product surface with their setup retained.

## What the Capy reference gets right

The supplied screenshots show a variable-length wizard rather than a fixed marketing tour. Team setup expands the path from five to eight steps. Every page keeps the same stable frame: brand and logout at the top, a narrow content column, progress above the heading, and back/continue actions anchored near the bottom. Optional integration steps say so through a visible Skip action. External GitHub authorization returns into the same task. The last screen is not a generic success message; it offers concrete ways to start working.

Those patterns are the reference. Capy's name, mascot, copy, colors, and unsupported Slack/Linear promises are not.

## Current Jina constraints

- Clerk is the staging authentication and organization authority. Jina mirrors those memberships into durable tenant rows and uses the Jina tenant as the data, billing, GitHub, and artifact boundary.
- Jina's current Clerk session bootstrap requires a linked GitHub OAuth identity and usable GitHub access token before it can create the internal user, personal tenant, or tenant list. Onboarding therefore needs a preflight state for a Clerk user whose GitHub identity is missing: explain the requirement, open Clerk account management, and retry the Jina viewer bootstrap without rendering tenant-dependent steps prematurely.
- A personal tenant is already created during identity synchronization. A team path must create a real Clerk organization and wait for its Jina tenant mirror before continuing.
- GitHub repository selection belongs to the GitHub App installation screen. Jina should explain that handoff and show the authoritative connected-installation result instead of drawing a fake repository picker.
- Jina has no separate `Project` entity. Repositories belong directly to a workspace, so onboarding must not introduce a project-name field that cannot be represented after the wizard.
- The existing tenant review-trigger endpoint supports `every_commit`, `first_commit`, and `manual_only`; onboarding should save one of those exact values.
- The existing Codex connection component already performs the real device flow and encrypted credential save. It should be reused rather than reimplemented.
- Organization invitations already go through the Clerk adapter and retain Clerk's permission/error semantics.

## Proposed flow

The progress denominator is generated from the actual path. Personal setup contains six steps: workspace, starting job, GitHub, review policy, model, and finish. Team setup contains eight by adding organization and invitations. Tests enumerate both sequences so copy and navigation cannot drift from the denominator.

### 1. Choose a workspace

Question: “Who are you setting Jina up for?”

- Personal selects the viewer's personal Jina tenant.
- Team continues to organization setup.
- Continue remains disabled until a choice is made.

### 2. Name or select the organization (team only)

- Existing Jina organizations are selectable.
- Selecting an existing organization activates the matching Clerk organization before selecting its Jina tenant.
- A new name creates a real Clerk organization through the auth adapter, activates it, waits for the refreshed Clerk token, requests the Jina viewer to synchronize membership, and resolves the mirrored tenant by its authoritative `clerk_organization_id`.
- Mirroring uses a bounded retry with a visible timeout and Retry action. It never guesses the tenant from the organization name.
- Creation errors remain on this screen and keep the user's draft.

### 3. Choose a starting job

Question: “What should Jina help with first?”

- Review pull requests.
- Build a living code wiki.
- Trace issues and changes.

This choice personalizes the completion screen and default destination; it does not hide other product capabilities.

### 4. Connect GitHub

- Show the selected workspace and any authoritative active installations.
- “Connect GitHub” opens the configured GitHub App installation URL with a versioned state value carrying the selected tenant and one allowlisted flow marker (`onboarding`). The parser remains compatible with the legacy raw-tenant state already used by Integrations.
- The existing callback authorization remains the enforcement point: Jina verifies App ownership, viewer admin authority, repository IDs, and tenant binding.
- Return routing never accepts an arbitrary URL. After an authorized callback, only the known `/onboarding` route may be selected; callback parameters are stripped after consumption and connection state is refreshed.
- The step is skippable because a user may be evaluating the interface before receiving organization-admin approval.

### 5. Set the review policy

- Present the three supported review-trigger modes in plain language.
- Save the chosen mode through the tenant-scoped endpoint before advancing.
- Non-admin organization members see the current value but cannot overwrite it.
- This step is still relevant when the user's initial job is Wiki or Issues because it defines future PR behavior.

### 6. Connect a model

- Reuse the existing Codex connection component and device-code flow.
- Show authoritative connected/reconnect-required state.
- Allow “Skip for now”; Models remains available later for Codex, managed, or BYOK selection.

### 7. Invite teammates (team only)

- Accept comma- or newline-separated email addresses.
- Resolve the selected Jina tenant to its authoritative Clerk organization ID before enabling the form. Normalize, validate, deduplicate, and invite each address as `org:member` through that organization with bounded concurrency.
- Report per-address failures without losing successful invitations.
- The step is skippable and never appears for a personal workspace.

### 8. Start working

- Mark onboarding complete before navigation.
- Lead with the card matching the user's starting-job choice.
- Offer Reviews, Wiki, Issues, and Integrations as real destinations.
- Keep Back available so the user can revise configuration before completion.

## State and routing

Onboarding state is product guidance, not an authorization boundary. A vendor-neutral `useAppOnboarding()` adapter will validate and expose the versioned state, awaited writes, write errors, restart, and completion. Clerk mode stores the record in the authenticated account's unsafe metadata under `jinaOnboarding`; writes merge with and preserve unrelated keys such as `developerMode`. The legacy GitHub-auth development mode uses a viewer-scoped local-storage fallback. Missing metadata means “not started,” malformed or unknown versions fail safely as “not started,” and a failed write remains visible and retryable. The record contains only low-sensitivity UX state: status, current step, workspace kind, selected tenant ID, starting job, and timestamps. Secrets, installation tokens, Clerk organization IDs, email invitations, and repository lists are never stored there.

New Clerk sign-ups use `/onboarding` as their sign-up fallback destination. Merely lacking metadata does not redirect an existing user, which avoids forcing the wizard onto every pre-existing staging account. Once a user starts, `status: in_progress` makes the shell resume `/onboarding` after a later sign-in. Completion changes the status to `complete`. An account-menu “Setup guide” entry allows an intentional restart.

The onboarding route uses the existing application providers but renders without the dashboard sidebar/header. Shell routing first resolves Clerk authentication, never resume-redirects away from `/signin` or `/onboarding`, and only then applies the in-progress redirect. `/onboarding` renders a dedicated `onboarding-shell` and does not initialize application notices or misclassify the route as Reviews. This keeps identity, tenant selection, Codex state, and query caching shared while reproducing the focused reference frame without creating a redirect loop.

## Authoritative state and idempotency

Back changes navigation, not already committed external state. Revisiting a step always re-reads its authoritative source:

- An already-created organization is selected, not created again.
- An active GitHub installation is shown as connected and the install action changes to “Manage repositories.”
- Review-policy failure keeps the user on the step with their selection and a Retry action; a successful save reads back the API value.
- Codex renders its existing authoritative connection state.
- Successful invitations stay visibly successful; repeated addresses are deduplicated and cannot be resubmitted during the same run.

External writes are disabled while in flight. A reload resumes from metadata, then reconciles the selected tenant and step data before enabling Continue.

## Implementation slices

1. Add pure, tested onboarding state/step helpers.
2. Extend the auth adapter with versioned onboarding progress, account-management preflight, organization creation/activation, and metadata-safe writes without leaking Clerk types into product components.
3. Add a chrome-less `/onboarding` route and explicit shell routing order for new sign-ups, GitHub-identity preflight, resume, restart, and completion.
4. Build the responsive wizard and Jina-specific visual treatment.
5. Reuse and extend GitHub installation routing so callbacks can return to onboarding.
6. Wire review-trigger persistence, Codex connection, and Clerk invitations.
7. Add component tests for conditional steps, validation, persistence, and failure states; extend pure tests around GitHub callback routing.
8. Run typecheck, lint, unit/integration suites, production builds, and browser QA at desktop and mobile widths.

## Acceptance criteria

- A new sign-up enters onboarding; an existing account with no onboarding metadata is not interrupted.
- A new Clerk account without a linked GitHub identity sees the recoverable preflight instead of a blank or tenant-dependent screen.
- Starting and abandoning the wizard resumes it on the next authenticated visit.
- Personal and team paths show correct, stable progress counts and Back behavior.
- Team organization creation produces a real Clerk organization and selects the corresponding Jina tenant.
- Organization selection/creation activates the matching Clerk organization and handles mirror timeout without guessing identity.
- GitHub callback routing cannot select a tenant the viewer cannot administer and returns onboarding installs to the wizard.
- Review mode is read from and saved to the real tenant endpoint.
- Codex uses the existing device flow; no credential is copied into onboarding state.
- Invitations target only the selected Clerk organization and expose partial failures.
- Skip is available only on genuinely optional steps.
- Keyboard focus is visible, controls have accessible names, status/error copy is announced, and the flow remains usable at 390 px wide.
- Completion is persisted before the selected destination opens.
- Repository checks and the dashboard production build pass.
- Browser QA confirms the full six-step personal path, eight-step team path, GitHub-identity preflight, redirect-loop prevention, conditional screens, back/skip behavior, callback query stripping, and responsive layout.

## Deliberate non-goals

- Copying Capy's brand, mascot, wording, or pixel values.
- Adding Slack or Linear before Jina has corresponding product integrations.
- Inventing a project entity or repository picker outside GitHub's installation permissions.
- Making onboarding metadata an access-control decision.
- Blocking evaluation on GitHub, Codex, or teammate invites.

## Release plan

The release sequence is: run staging readiness checks; open a PR targeting `staging`; wait for CI/review; merge the PR (the user authorized a staging deployment); capture the exact new `origin/staging` SHA; wait for the source-bound `jina-staging-deploy` Cloud Build; verify the separate `jina-staging-dashboard` deployment is serving the same SHA; then run `docs/STAGING_PR_E2E.md` plus onboarding smoke tests. PR creation alone is not a deployment. The Cloud Build lane builds immutable API/worker images, runs migrations and acceptance gates, and deploys the exact merge SHA to the isolated `jina-staging-20260802` project. The smoke test covers sign-up redirect, missing-GitHub preflight, personal completion, GitHub connect/return, review-policy persistence, and organization invitation success/failure.

## Independent audit

An independent subagent reviewed this document before implementation for unsupported product claims, identity/tenant mistakes, callback security, incomplete failure handling, accessibility gaps, test omissions, and staging-release risk.

Audit status: completed and addressed on 2026-08-07.

| Finding                                                          | Disposition                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| New Clerk users may lack Jina's required GitHub identity         | Accepted; added the GitHub-identity preflight and test requirement.                                                |
| Clerk organization creation did not define activation/mirroring  | Accepted; added activate, refresh, authoritative-ID resolution, bounded retry, and timeout UI.                     |
| PR creation was incorrectly conflated with deployment            | Accepted; release plan now requires merge/push, exact SHA tracking, both deploy lanes, and E2E.                    |
| GitHub callback state/return routing was underspecified          | Accepted; added a versioned codec, legacy compatibility, allowlisted return, reauthorization, and query stripping. |
| Shell routing order and chrome-less behavior were underspecified | Accepted; added exact auth/resume ordering and redirect-loop coverage.                                             |
| No metadata adapter contract existed                             | Accepted; added validated reads, awaited merge-preserving writes, failure behavior, and fallback semantics.        |
| Personal progress count did not match the listed steps           | Accepted; corrected to six personal and eight team steps generated from tested sequences.                          |
| Invitation targeting lacked Clerk organization resolution        | Accepted; added authoritative Clerk ID resolution, default role, bounded concurrency, and partial-result handling. |
| Back/retry behavior for irreversible actions was missing         | Accepted; added authoritative reconciliation and idempotency rules.                                                |
| Audit status remained pending                                    | Accepted; this table records the completed audit and every disposition.                                            |

## Implementation record

Implemented on `codex/capy-inspired-onboarding` on 2026-08-07. The delivered flow includes the versioned progress adapter, GitHub-identity preflight, six-step personal and eight-step team paths, authoritative Clerk organization mirroring, versioned GitHub App return state, tenant review-policy persistence, the existing Codex connection flow, Clerk invitations, completion destinations, account-menu restart, and a dedicated responsive shell.

Verification before staging release:

- dashboard lint and TypeScript checks pass;
- 160 dashboard unit tests and 36 component tests pass, including progress, redirect, GitHub callback, preflight, and personal-flow coverage;
- the Next.js production build succeeds with `/onboarding` in the route manifest;
- in-app browser QA passed at the default desktop viewport and 390 × 844 with no horizontal overflow or console errors;
- browser QA identified and the implementation corrected a non-Clerk invite-hook crash plus an unrecoverable preflight loading state before release.
