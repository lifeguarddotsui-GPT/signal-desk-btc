---
name: Small-phone signal hierarchy
description: Visual verification rule for time-sensitive BTC one-minute decision screens
---

On the smallest phone screen, show the live chart and the HOLD/decision with its full reason without scrolling. The chart may precede the detailed evidence and model section; keep the round, countdown, and Coinbase comparison label immediately visible. Never omit the reason or hide the chart below several cards.

**Why:** An earlier responsive design buried the chart under a large HOLD card; moving the chart first then pushed HOLD below the first screen. In a one-minute round, the user needs both immediately. A passing build and desktop screenshot missed each mobile failure.

**How to apply:** After any Live layout change, capture an actual 320×720 viewport and read its visible content. Keep Coinbase comparison clearly labeled and show the full HOLD reason even when the model is unavailable or the round expires.