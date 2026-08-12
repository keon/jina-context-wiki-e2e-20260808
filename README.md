# Jina staging review fixture

Staging-only fixture for the Trigger.dev review workflow. Run the executable fixture with:

```sh
npm test
```

The redirect policy is intended for OAuth callback validation at the application boundary.

## Trigger-only review framework canary

This pull request is the exact-source staging acceptance for Jina release `bbd18f1963c6bf81f3fd1a44eadc05e76fc77ec1`. It must be admitted through Pub/Sub as one immutable work request and completed by the `review` Trigger.dev task without Board or Cloud Run workers.
