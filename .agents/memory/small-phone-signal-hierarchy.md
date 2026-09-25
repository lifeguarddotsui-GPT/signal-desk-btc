---
name: Small-phone signal hierarchy
description: Visual verification rule for time-sensitive BTC one-minute decision screens
---

On the smallest phone screen, show the round, countdown, calibrated forecast or explicit unavailability, evidence strength, HOLD/direction, and its full reason before the chart.

**Why:** A responsive implementation and passing build still placed the decision below the first screen; shortening the chart alone did not resolve the hierarchy. The user must be able to understand the decision without scrolling during a one-minute round.

**How to apply:** After any Live layout change, capture an actual 320×720 viewport and read its visible content. Keep Coinbase comparison clearly labeled even when the chart moves below the decision.