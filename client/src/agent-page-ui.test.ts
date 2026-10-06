import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AgentPage from "./AgentPage";

test("public agent SSR is observation-only and never claims execution readiness", () => {
  const html = renderToStaticMarkup(createElement(AgentPage));
  assert.match(html, /IDENTITY IS NOT AUTHORITY/);
  assert.match(html, /Experimental qualification gates/i);
  assert.match(html, /USDC/);
  assert.match(html, /not reported/i);
  assert.match(html, /simulate owner actions before a transaction payload is prepared/i);
  assert.doesNotMatch(html, /qualified for live execution/i);
});