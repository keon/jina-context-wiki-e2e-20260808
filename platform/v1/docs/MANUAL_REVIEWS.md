# Manual PR Reviews

Repository collaborators with write access can start a new review by including
a standalone `@usejina` mention anywhere in a newly created pull request comment:

```text
@usejina do another round of review. Be strict.
```

Only the newest authorized `@usejina` comment on a pull request is worked. When
a newer command arrives, older queued or running manual reviews finish as
superseded and skip further publication. This does not cancel unrelated
automatic reviews.
Redelivery of the same GitHub comment is idempotent and does not create another
run.

## Manual-only mode

Organization admins can select **Manual trigger only** under **Models → Review
triggers**. In this mode, opening, reopening, marking ready, or pushing to a pull
request does not start a review. A new pull request comment containing a
standalone `@usejina` mention is the only way to trigger one.

## Preferences and scope

The rest of the comment, before or after the mention, is used as guidance for
that review only:

```text
@usejina

Prioritize authorization and retry behavior.
Ignore formatting-only feedback.
```

Scope can be stated in the same way:

```text
@usejina

Review only the webhook retry path. Do not investigate unrelated UI changes.
```

Jina passes this text to every model-backed review stage as the highest-priority
configurable guidance. When it limits scope, the planner, investigators,
replanner, and final reviewer must not add unrelated areas or findings. The
precedence is:

1. Jina defaults.
2. Base-branch `.jina/instruction.md`.
3. The matching base-branch `.jina/<step>/instruction.md`.
4. Instructions in the authorized `@usejina` comment for this run.
5. Jina's fixed output, evidence, safety, system, and developer constraints.

Run-specific instructions are limited to 8,000 Unicode characters. Commands
over that limit are ignored rather than partially applying their preferences or
scope.

## Re-review one Jina issue

Reply to a Jina-generated inline finding with the same command:

```text
@usejina

Use the existing retry regression test when reproducing this.
```

For a verified finding produced by the installed Jina GitHub App, Jina appends a
fixed, higher-priority boundary naming the parent finding, so the additional
preferences apply within that issue. An `@usejina` comment outside a Jina
finding reviews the PR normally.

## GitHub App configuration

The App must receive `issue_comment` and `pull_request_review_comment` webhook
events. It needs Issues read, pull requests read/write, contents read, and its
normal metadata access. The API also needs `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` so it can verify collaborator permission and read the
current PR before dispatching the review.
