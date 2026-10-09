import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import AgentPage from "./AgentPage";

test("public agent SSR is observation-only and never claims execution readiness", () => {
  const html = renderToStaticMarkup(createElement(AgentPage));
  assert.match(html, /IDENTITY IS NOT AUTHORITY/);
  assert.match(html, /Experimental qualification gates/i);
  assert.match(html, /not reported/i);
  assert.match(html, /Live agent temporarily unavailable/i);
  assert.match(html, /System diagnostics/);
  assert.match(html, /shadow mode/i);
  assert.doesNotMatch(html, /qualified for live execution/i);
  assert.match(html, /Connect Slush/);
  assert.doesNotMatch(html, /Paper ledger|Paper counters|paper-ledger starting capital|Start shadow session|ARM_SHADOW/i);
  const source = readFileSync(new URL("./AgentPage.tsx", import.meta.url), "utf8");
  assert.match(source, /ownerSetupSigning !== true/);
  assert.match(source, /signReviewedOwnerTransaction/);
  assert.match(source, /\/owner-confirm/);
  assert.match(source, /dollarsToAtomicAmount\(amountHuman, decimals\)/);
  const guided = readFileSync(new URL("./GuidedAgentSetup.tsx", import.meta.url), "utf8");
  assert.match(guided, /Retry confirmation only/);
  assert.match(guided, /ownerSubmissionPending/);
});