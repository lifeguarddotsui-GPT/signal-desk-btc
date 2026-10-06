---
name: Small-phone signal hierarchy
description: Visual verification rule for time-sensitive WaterX BTC round screens
---

On the Live Desk, prioritize interval/countdown, permanent live UP/DOWN percentages, provisional lean or saved lock, qualification progress and one blocker, followed by current BTC/reference/difference and chart. Extended choice history, explanations and diagnostics must not displace the main flow.

**Why:** The user's lean-to-lock brief explicitly restored this hierarchy. Readiness is not win probability; missing odds retain both percentage positions. A passing build and desktop screenshot previously missed mobile failures.

**How to apply:** After any Live layout change, render at 320, 375, 390 and 430 CSS-pixel viewport widths and read the visible content. Keep source labels legible and stale/withheld states explicit rather than assuming the desktop layout survives.

In this workspace, a direct headless Chromium screenshot of the live dashboard can hang, including through its debugging protocol. A temporary same-origin HTML QA page with fixed-width iframes to the real app can instead render actual 320–430 CSS-pixel viewports in the working app-preview screenshot tool; remove the page after capture. This is responsive browser emulation, not a physical-device check.

**Why:** Independent direct browser capture approaches hung while desktop preview and the app itself worked; the same-origin iframe method captured the current responsive layout without changing app code or data.

**How to apply:** Use a working browser viewport capture or temporary same-origin iframe harness; distinguish emulation from a physical phone and remove the test page afterward. Do not label historical mobile images as verification of newer UI changes.

Capture the desktop and responsive harness sequentially, not in parallel.

**Why:** Parallel captures produced completely blank harness iframes while the main app rendered; a subsequent single harness capture rendered all four real viewports.

**How to apply:** Treat captures as potentially sharing browser resources. Inspect the returned image before retaining it as evidence.