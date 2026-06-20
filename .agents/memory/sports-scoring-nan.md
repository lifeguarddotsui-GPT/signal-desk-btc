---
name: Sports scoring NaN from empty form array
description: formScore division-by-zero when fighter lastFights array is empty; produces NaN confidenceScore stored as null in DB
---

## Rule
In `rankingEngine.ts` `scoreSportsMarket`, always guard formScore against empty array:
```ts
const formScore = form.length > 0 ? (wins / form.length) * 10 : 5;
```
Default of 5 (mid-range) is appropriate when no recent fight data exists.

**Why:** `makeFighterFromRecord()` in sportsResearch.ts builds fighter objects from win/loss record strings (e.g. "25-13-0") with an empty `lastFights: []` array. This propagates to `homeForm`/`awayForm` as `[]`. `wins / 0 = NaN` then poisons the weighted average, producing NaN finalScore. PostgreSQL `real NOT NULL` column stores NaN as null. Old null signals persist in DB and display as "0.0" confidence until replaced.

**How to apply:** Any new scoring formula that uses `form.length` as denominator must have this guard. Also applies if `event.homeForm` or `event.awayForm` could be undefined (treat as empty array first).
