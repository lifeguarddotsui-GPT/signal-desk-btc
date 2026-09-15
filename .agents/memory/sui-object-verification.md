---
name: Sui object verification transport
description: Current transport constraint for independently verifying Sui packages and shared Move objects.
---

Public Sui fullnodes return “Method not found” for legacy JSON-RPC object reads. Verify objects through Sui mainnet GraphQL, including package presence, object ownership, version, and Move type.

**Why:** A collector appeared healthy but verified zero assets because the deprecated JSON-RPC method failed for every object while the upstream market feed remained available.

**How to apply:** Treat upstream launchpad records as discovery only. Resolve every reported package and curve through GraphQL before marking it verified, and expose zero verified assets rather than falling back to unverified provider data.