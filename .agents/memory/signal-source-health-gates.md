---
name: Signal source health gates
description: Minimum independent market-data coverage required before a SUI or DEEP opportunity is actionable.
---

Treat an asset as actionable only when its centralized spot price, centralized derivatives data, and Sui-native spot data are all live. Missing coverage must remain explicit and must suppress the asset from best-opportunity and SMS eligibility.

**Why:** A technical setup can appear strong while funding, open interest, or native-liquidity confirmation is unavailable. Presenting that setup as actionable would overstate confidence and weaken paid alerts.

**How to apply:** Keep each source family independently attributed and timestamped. Never infer a missing value as zero, and never count an aggregator route as an additional independent venue.