---
name: Coinbase 4H candles
description: How to obtain accurate four-hour candles from the Coinbase Exchange public API.
---

Coinbase Exchange does not accept a 14,400-second candle granularity. Build 4H candles by aligning 1H candles to four-hour UTC buckets and aggregating open, high, low, close, and volume.

**Why:** Requesting a native 4H granularity returns HTTP 400, while substituting a supported 6H interval would silently mislabel the analysis.

**How to apply:** Whenever the product needs 4H Coinbase structure, fetch 1H candles and aggregate four consecutive, UTC-aligned observations.