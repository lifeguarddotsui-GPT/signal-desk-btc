import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AgentPage from "./AgentPage";

test("public agent SSR is observation-only and never claims execution readiness", () => {
  const html = renderToStaticMarkup(createElement(AgentPage));
  assert.match(html, /SHADOW OBSERVATION ONLY/);
  assert.match(html, /no executable adapter is verified/i);
  assert.match(html, /No hypothetical fills, trade outcomes, or compounding results are generated here/i);
  assert.match(html, /RELEASE UNAVAILABLE/);
  assert.match(html, /Balance not reported/);
  assert.doesNotMatch(html, /qualified for live execution/i);
});