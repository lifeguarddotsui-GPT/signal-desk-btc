import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("history and operations offer an isolated 50/50 fallback source", () => {
  assert.match(app, /import type \{ HistorySource \} from "\.\.\/\.\.\/shared\/canonical-history"/);
  assert.match(app, /source: HistorySource/);
  assert.match(app, /history\?interval=\$\{interval\}&source=\$\{historySource\}/);
  assert.equal((app.match(/<option value="fallback">Deterministic 50\/50 fallback · research-only<\/option>/g) ?? []).length, 2);
  assert.match(app, /evidence\.tieBreakApplied === true/);
  assert.match(app, /low-confidence research cohort, isolated from baseline and champion denominators/);
  assert.match(app, /No trade, return, or P&amp;L inference/);
});