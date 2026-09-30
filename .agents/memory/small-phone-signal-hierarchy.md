---
name: Small-phone signal hierarchy
description: Visual verification rule for time-sensitive WaterX BTC round screens
---

On the smallest phone screen, show the round's WaterX reference, clearly labeled Coinbase comparison, distance, countdown and the beginning of the chart before extended diagnostics. Place the advisory and model-reliability explanation immediately after the chart, not in an oversized leading HOLD card.

**Why:** An earlier responsive design buried the chart under a large HOLD card. The current product is 5m/15m rather than the former one-minute desk, but its source labels and timer still need to remain visible at narrow widths. A passing build and desktop screenshot missed mobile failures.

**How to apply:** After any Live layout change, render at 320, 375, 390 and 430 CSS-pixel viewport widths and read the visible content. Keep source labels legible and stale/withheld states explicit rather than assuming the desktop layout survives.

In this workspace, a direct headless Chromium screenshot of the live dashboard can hang, including through its debugging protocol. A temporary same-origin HTML QA page with fixed-width iframes to the real app can instead render actual 320–430 CSS-pixel viewports in the working app-preview screenshot tool; remove the page after capture. This is responsive browser emulation, not a physical-device check.

**Why:** Independent direct browser capture approaches hung while desktop preview and the app itself worked; the same-origin iframe method captured the current responsive layout without changing app code or data.

**How to apply:** Use a working browser viewport capture or temporary same-origin iframe harness; distinguish emulation from a physical phone and remove the test page afterward. Do not label historical mobile images as verification of newer UI changes.