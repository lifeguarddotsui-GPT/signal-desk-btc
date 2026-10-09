import test from "node:test";
import assert from "node:assert/strict";
import {chartTimeAxis} from "./chart-axis";
test("time ticks fit phones, laptop/desktop and enlarged text with inward endpoints",()=>{
  for(const width of [320,375,390,430,1024,1440]){
    for(const scale of [1,1.5,2]){
      for(const interval of [5,15]){
        const start=Date.UTC(2026,9,6,22),end=start+interval*60000;
        const plotWidth=Math.max(100,(width<900?width-32:width*2/3-32)-120);
        const ticks=chartTimeAxis(start,end,plotWidth,scale);
        assert.equal(ticks[0].at,start);assert.equal(ticks.at(-1)!.at,end);
        assert.equal(ticks[0].align,"left");assert.equal(ticks.at(-1)!.align,"right");
        assert(ticks.length<=6);assert(ticks.length>=2);
        assert(ticks.every(t=>!t.label.includes("UTC")));
        assert((ticks.length-1)*78*scale<=plotWidth||ticks.length===2);
      }
    }
  }
  assert(chartTimeAxis(0,900000,600,2).length<chartTimeAxis(0,900000,600,1).length);
});
