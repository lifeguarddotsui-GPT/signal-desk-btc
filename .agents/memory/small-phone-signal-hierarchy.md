---
name: Small-phone signal hierarchy
description: Visual verification rule for time-sensitive WaterX BTC round screens
---

On the Live Desk, keep WaterX reference, clearly labeled Coinbase comparison, distance and countdown visible, then put deterministic readiness progress and its exact blocker directly above the chart on phones. Put extended choice history, model explanations and diagnostics after the chart.

**Why:** The user explicitly requires readiness progress and blocker above the mobile chart so users can see timely round state. This supersedes the older chart-first priority, but does not justify burying the chart beneath extended diagnostics. A passing build and desktop screenshot missed mobile failures.

**How to apply:** After any Live layout change, render at 320, 375, 390 and 430 CSS-pixel viewport widths and read the visible content. Keep source labels legible and stale/withheld states explicit rather than assuming the desktop layout survives.

In this workspace, a direct headless Chromium screenshot of the live dashboard can hang, including through its debugging protocol. A temporary same-origin HTML QA page with fixed-width iframes to the real app can instead render actual 320–430 CSS-pixel viewports in the working app-preview screenshot tool; remove the page after capture. This is responsive browser emulation, not a physical-device check.

**Why:** Independent direct browser capture approaches hung while desktop preview and the app itself worked; the same-origin iframe method captured the current responsive layout without changing app code or data.

**How to apply:** Use a working browser viewport capture or temporary same-origin iframe harness; distinguish emulation from a physical phone and remove the test page afterward. Do not label historical mobile images as verification of newer UI changes.

Capture the desktop and responsive harness sequentially, not in parallel.

**Why:** Parallel captures produced completely blank harness iframes while the main app rendered; a subsequent single harness capture rendered all four real viewports.

**How to apply:** Treat captures as potentially sharing browser resources. Inspect the returned image before retaining it as evidence.