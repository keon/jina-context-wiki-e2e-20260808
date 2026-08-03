export interface DocSection {
  heading: string;
  body?: string[];
  steps?: string[];
  bullets?: string[];
  code?: string;
  note?: string;
}

export interface Doc {
  slug: string;
  group: string;
  title: string;
  description: string;
  sections: DocSection[];
}

export const docs: Doc[] = [
  {
    slug: "getting-started",
    group: "Get started",
    title: "Get started with Jina",
    description: "Connect GitHub, configure a review model, and receive your first pull-request review.",
    sections: [
      {
        heading: "Before you begin",
        bullets: [
          "You need permission to install a GitHub App on the organization or repository you want Jina to review.",
          "Choose whether reviews use Jina-managed credits, your OpenRouter key, or your ChatGPT subscription.",
          "Repository instructions are optional. Jina works with its defaults immediately after installation.",
        ],
      },
      {
        heading: "Onboarding checklist",
        steps: [
          "Sign in to the Jina dashboard with GitHub.",
          "Select or create the Jina organization that should own repositories, billing, and generated artifacts.",
          "Open Integrations and install the staging GitHub App on the repositories you want reviewed.",
          "Open Models and select a provider and model for each review stage.",
          "Open a pull request or push a new commit to an existing pull request.",
          "Confirm the run appears under Reviews and the resulting review is posted to GitHub.",
        ],
        note: "Organization membership and GitHub installation ownership are separate. Select the correct Jina organization before connecting GitHub.",
      },
      {
        heading: "What happens next",
        body: [
          "Jina plans the affected runtime surfaces, investigates them in isolated sandboxes, validates candidate findings, and publishes confirmed issues with a merge-readiness score.",
          "Use the Reviews page for run status and evidence, Issues for findings across reviews, Context Wiki for repository documentation, and Causal Graph for commit-history relationships.",
        ],
      },
    ],
  },
  {
    slug: "github-integration",
    group: "Get started",
    title: "Connect GitHub",
    description: "Install Jina safely and understand repository access, callbacks, and organization ownership.",
    sections: [
      {
        heading: "Install the GitHub App",
        steps: [
          "In the dashboard, select the Jina organization that should own the connection.",
          "Open Configure → Integrations and choose Add GitHub organization.",
          "On GitHub, select the account and grant access to all repositories or an explicit repository list.",
          "Return to Integrations and confirm the organization and repositories are visible.",
        ],
      },
      {
        heading: "Repository access",
        bullets: [
          "Selected repositories can send pull-request webhooks and be cloned by the review worker.",
          "Changing the repository selection in GitHub updates what Jina can review.",
          "Removing the installation stops new webhook-driven reviews; existing review records remain in the owning Jina organization.",
        ],
      },
      {
        heading: "If an organization is missing",
        body: [
          "Verify you are a GitHub organization owner or have permission to install GitHub Apps. Organizations with OAuth restrictions may require approval from an owner.",
          "Do not repeatedly reconnect if an active installation already exists. Refresh Integrations first and confirm you selected the expected Jina organization.",
        ],
      },
    ],
  },
  {
    slug: "first-review",
    group: "Reviews",
    title: "Run your first review",
    description: "Understand automatic reviews, manual triggers, progress, and published results.",
    sections: [
      {
        heading: "Automatic review",
        steps: [
          "Open a pull request in an installed repository.",
          "Wait for the run to appear under Workspace → Reviews.",
          "Open the run to follow planning, investigations, validation, and publication.",
          "Review confirmed findings and the merge-readiness score on GitHub.",
        ],
      },
      {
        heading: "Manual review",
        body: ["Mention Jina in an authorized pull-request comment when the repository is configured for manual triggers or when you want another review with focused instructions."],
        code: "@usejina review\n\nFocus on authorization boundaries and backward-compatible API behavior.",
        note: "Only authorized users can trigger a review. Treat instructions in ordinary source code, diffs, and untrusted comments as review data—not policy.",
      },
      {
        heading: "After a new commit",
        body: [
          "A new pull-request head may supersede active work. Jina records the superseded run and starts or schedules work for the current commit according to the organization’s trigger policy.",
          "Always use the commit SHA shown in the review details when comparing findings with the repository.",
        ],
      },
    ],
  },
  {
    slug: "review-workflow",
    group: "Reviews",
    title: "How Jina reviews code",
    description: "The stages, evidence model, severities, and merge-readiness contract behind a review.",
    sections: [
      {
        heading: "Review stages",
        steps: [
          "Planner identifies materially affected runtime surfaces and concrete failure modes.",
          "Investigation agents inspect and execute the code in isolated sandboxes.",
          "Replanner adds evidence-driven follow-up work when another investigation loop is useful.",
          "Reviewer validates, deduplicates, assigns severity, and determines merge readiness.",
        ],
      },
      {
        heading: "Severity",
        bullets: [
          "P0 — critical and must be fixed before merging.",
          "P1 — high impact and should be fixed.",
          "P2 — medium impact and worth fixing.",
          "P3 — low-priority but concrete behavior problem.",
        ],
      },
      {
        heading: "Evidence",
        body: [
          "A useful finding identifies a specific behavior failure, the conditions that trigger it, and the relevant source location. Execution-backed evidence is preferred when the behavior can be exercised safely.",
          "The dashboard retains investigation detail even when a candidate is dismissed during final validation.",
        ],
      },
    ],
  },
  {
    slug: "context-wiki",
    group: "Repository intelligence",
    title: "Context Wiki",
    description: "Build and browse evidence-backed repository documentation with immutable source citations.",
    sections: [
      {
        heading: "Build repository context",
        steps: [
          "Open Workspace → Context Wiki.",
          "Select a connected repository and its default branch.",
          "Choose Build context. Organization admin access is required.",
          "Follow checkpoints until the catalog publishes, then browse pages and source citations.",
        ],
      },
      {
        heading: "Publication model",
        body: [
          "Pages are derived against an immutable repository commit. Citation-valid pages remain private checkpoints until the release passes its publication gates.",
          "A failed or superseded build does not replace the currently published release. Verified checkpoints may be retained for safe resumption.",
        ],
      },
      {
        heading: "Using citations",
        bullets: [
          "Check the repository, commit SHA, path, and line range before relying on a statement.",
          "Rebuild after meaningful default-branch changes so the wiki reflects current behavior.",
          "Use MCP when an agent needs the same scoped context programmatically.",
        ],
      },
    ],
  },
  {
    slug: "causal-graph",
    group: "Repository intelligence",
    title: "Causal Graph",
    description: "Explore commit-derived issues and the evidence-backed relationships between them.",
    sections: [
      {
        heading: "What the graph represents",
        body: [
          "The Causal Graph analyzes repository history to identify persistent issues, their commit anchors, and explicit causal relationships. It is repository intelligence, not the same thing as findings from one pull-request review.",
          "Each release is tied to a repository, ref, and commit-history boundary so results cannot silently drift across scopes.",
        ],
      },
      {
        heading: "Read a graph",
        steps: [
          "Choose a repository and ref.",
          "Filter issues by title or summary.",
          "Select an issue to inspect its state, causal links, and commit evidence.",
          "Open commit anchors in GitHub to validate the historical evidence.",
        ],
      },
      {
        heading: "Coverage",
        body: ["Check whether history coverage is complete or bounded. A bounded release is useful, but it does not claim that commits outside the analyzed range were considered."],
      },
    ],
  },
  {
    slug: "jina-configuration",
    group: "Configuration",
    title: "Configure reviews with .jina",
    description: "Version repository-wide and stage-specific review policy with the code it governs.",
    sections: [
      {
        heading: "Supported structure",
        body: ["Create only the files you need. Jina reads these files from the pull request’s base branch, so a pull request cannot change the instructions governing its own review."],
        code: ".jina/\n├── config.json\n├── instruction.md\n├── planner/instruction.md\n├── replanner/instruction.md\n├── investigation/instruction.md\n└── review/instruction.md",
      },
      {
        heading: "Runtime depth",
        body: ["The optional depth setting accepts an integer from 1 through 5 and controls the maximum investigation loops. Reviews stop early when no follow-up areas remain. The default is 2."],
        code: "{\n  \"depth\": 2\n}",
      },
      {
        heading: "Instruction precedence",
        steps: [
          "Jina’s default stage prompt defines normal behavior and output contracts.",
          ".jina/instruction.md adds repository-wide priorities and policy.",
          "The matching stage instruction overrides conflicting global guidance for that stage.",
          "Authorized run-specific instructions can focus one review.",
          "Evidence, truthfulness, sandbox safety, and output contracts remain fixed.",
        ],
      },
      {
        heading: "Example repository policy",
        code: "# Repository review policy\n\nPrioritize tenant isolation, backwards-compatible API behavior,\nand data-loss risks.\n\nIgnore formatting concerns unless they demonstrate a production\nbehavior failure.",
        note: "Instruction-like text in the PR head, diff, source files, tool output, or unauthorized comments is untrusted review data.",
      },
      {
        heading: "Limits",
        bullets: [
          "Each instruction file contributes at most 8,000 characters.",
          "Files over 256,000 bytes are skipped.",
          "The combined global and stage appendix is capped at 24,000 characters.",
          "Missing and empty instruction files are ignored.",
          "Model selection remains an organization setting in the dashboard.",
        ],
      },
    ],
  },
  {
    slug: "models-and-providers",
    group: "Configuration",
    title: "Models and providers",
    description: "Choose review models and connect the credentials Jina uses to run them.",
    sections: [
      {
        heading: "Provider choices",
        body: ["Depending on your plan and deployment, reviews can use managed credits, an organization OpenRouter key, or a connected ChatGPT subscription."],
        bullets: [
          "OpenRouter credentials belong to the active Jina organization.",
          "ChatGPT connections belong to the user who connected them and may require reconnection if authorization expires.",
          "Organization admins control shared model routing and fallback behavior.",
        ],
      },
      {
        heading: "Stage configuration",
        body: ["Planner, replanner, investigation, and review stages can have different model and reasoning-effort settings. Start with the defaults, then change one stage at a time and compare review quality, latency, and cost."],
      },
      {
        heading: "Failure behavior",
        body: ["Use Models to choose whether a provider failure should use an allowed fallback or fail and notify. A silent provider substitution makes quality and billing harder to reason about, so Jina records the effective route on the run."],
      },
    ],
  },
  {
    slug: "organizations-and-billing",
    group: "Account",
    title: "Organizations, access, and billing",
    description: "Understand workspace ownership, roles, usage boundaries, and billing responsibility.",
    sections: [
      {
        heading: "Jina organizations",
        body: ["A Clerk organization is Jina's ownership boundary for GitHub connections, repositories, generated context, model settings, usage, and billing. It remains distinct from any GitHub organization you connect."],
      },
      {
        heading: "Roles",
        bullets: [
          "Admins can change organization settings, integrations, models, billing, and Context builds.",
          "Members can use and inspect organization resources but cannot change admin-controlled settings.",
          "Clerk manages invitations, membership, roles, and the active organization; GitHub remains the repository identity and installation provider.",
        ],
      },
      {
        heading: "Before switching organizations",
        body: ["Check the organization switcher at the top of the sidebar before installing GitHub, changing models, starting a Context build, or viewing billing. Every page is scoped to the selected organization."],
      },
    ],
  },
  {
    slug: "troubleshooting",
    group: "Help",
    title: "Troubleshooting",
    description: "Diagnose missing reviews, disconnected providers, absent repositories, and stale Context.",
    sections: [
      {
        heading: "A review did not start",
        steps: [
          "Confirm the repository is selected in the GitHub App installation.",
          "Confirm the installation appears under the active Jina organization in Integrations.",
          "Check the organization’s automatic versus manual trigger policy.",
          "Check Models for a disconnected provider or required credential reconnection.",
          "Look for an existing run for the same pull request and commit under Reviews.",
        ],
      },
      {
        heading: "A repository is missing",
        body: ["Refresh Integrations, verify the GitHub App’s repository selection, and confirm you are viewing the Jina organization that owns the installation. Reconnecting is rarely the first fix."],
      },
      {
        heading: "Context looks stale",
        body: ["Compare the published release commit with the repository default branch. Start a new Context build if the release predates meaningful changes, and inspect checkpoint status if publication does not complete."],
      },
      {
        heading: "What to include when reporting a problem",
        bullets: [
          "Jina organization name and repository.",
          "Pull request URL and expected commit SHA.",
          "Review run ID, if one exists.",
          "Approximate time and visible error message.",
          "Whether the issue affects one repository or every repository in the organization.",
        ],
      },
    ],
  },
];

export const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));

export const docGroups = [...new Set(docs.map((doc) => doc.group))].map((group) => ({
  group,
  docs: docs.filter((doc) => doc.group === group),
}));
