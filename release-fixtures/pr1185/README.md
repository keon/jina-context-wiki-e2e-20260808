# Shipping calculation

This module quotes domestic shipping in integer cents. Orders of at least 5,000 cents qualify for free shipping; smaller orders cost 499 cents. Reject negative, fractional, non-numeric, and non-finite subtotals. It is dependency-free. Run `node --test release-fixtures/pr1185/shipping.test.mjs` from the repository root.
