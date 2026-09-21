# Suipump Mainnet verification

The Suipump indexer is discovery and enrichment only. Sui Mainnet checkpoints, transaction effects, object types, and package bytecode are the trust boundary.

| Finding | Status | Evidence |
|---|---|---|
| Current observed write package `0xb205…9b0` exists on Mainnet | VERIFIED_ON_CHAIN | Sui Mainnet GraphQL package-object query |
| Current accepted curves are shared objects from the pinned package | VERIFIED_ON_CHAIN | Curve owner and Move type checks |
| Curve generic token type equals the discovered coin type | VERIFIED_ON_CHAIN | Exact Move-type comparison |
| Indexer records alone authorize trading | REJECTED | Discovery data cannot enter the signer allowlist |
| Original defining package and upgrade ancestry | UNRESOLVED | Requires package history and representative transaction decoding |
| Buy module/function and effects | UNRESOLVED | No decoded successful Mainnet buy sample accepted yet |
| Sell module/function and effects | UNRESOLVED | No decoded successful Mainnet sell sample accepted yet |
| Creation/graduation route and events | UNRESOLVED | No decoded creation/graduation sample accepted yet |
| Public source matches deployed bytecode interfaces | UNRESOLVED | Source repository currently describes testnet |
| Version-aware executable adapter | UNRESOLVED | Must follow verified transaction samples, not copied constants |

No package, module, function, shared object, or coin type in an `UNRESOLVED` row is eligible for signing.