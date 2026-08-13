# jina-context-wiki-e2e-20260808

Staging-only executable fixture for the OpenWiki review workflow.

The repository exports `quoteShipping` from `src/shipping.js`. It validates
currency and weight as safe integers, accepts only the `domestic` and
`international` string zones, applies free base shipping at 5,000 cents, and
retains the international weight surcharge. Run all six policy checks with:

```sh
npm test
```

The surrounding staging acceptance run—not this repository's local test
command—verifies the exact-head Wiki build, review-agent Wiki MCP access,
external API/MCP access, token revocation, and authenticated dashboard rendering.
