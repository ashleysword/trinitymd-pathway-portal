# Inactive code

`clinic-wholesale-pricing` is a Shopify discount Function that was meant to replace Massy's volume rules. The store is on Shopify Basic, and only Plus stores can run custom apps that contain Functions, so it is **inactive**:

- It sits outside `extensions/`, so `shopify app deploy` does not deploy it.
- `scripts/wholesale-discount.mjs --apply` refuses to run.
- Its tests still run, so the code stays correct if the store ever moves to Plus.

Massy keeps the wholesale prices. See `../MASSY-REPLACEMENT.md`.
