import EventEmitter from "events";

export type PriceTick = {
  symbol: "SUI";
  pyth: { price: number; conf?: number; publishTime?: number } | null;
  blended: number;
  ts: number;
};

export const priceBus = new EventEmitter();
priceBus.setMaxListeners(100);

const state: { last?: PriceTick } = {};

const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PYTH_SUI_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";

async function fetchPythSui(): Promise<{ price: number; conf?: number; publishTime?: number }> {
  const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${encodeURIComponent(PYTH_SUI_FEED_ID)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`pyth http ${res.status}`);
  const json = await res.json();

  const p = json?.parsed?.[0]?.price;
  if (!p) throw new Error("pyth parse error");
  const price = Number(p.price) * Math.pow(10, Number(p.expo));

  return {
    price,
    conf: p.conf ? Number(p.conf) * Math.pow(10, Number(p.expo)) : undefined,
    publishTime: p.publish_time,
  };
}

let lastGoodPrice: number | null = null;

export async function fetchLivePrice(): Promise<PriceTick> {
  const pythResult = await fetchPythSui().catch(() => null);

  let blended: number;

  if (pythResult) {
    blended = pythResult.price;
    lastGoodPrice = blended;
  } else if (lastGoodPrice !== null) {
    blended = lastGoodPrice;
  } else {
    blended = 0;
  }

  const tick: PriceTick = {
    symbol: "SUI",
    pyth: pythResult,
    blended,
    ts: Date.now(),
  };

  state.last = tick;
  priceBus.emit("tick", tick);
  return tick;
}

export function getLastPrice(): PriceTick | undefined {
  return state.last;
}

let priceInterval: ReturnType<typeof setInterval> | null = null;

export function startPriceLoop() {
  if (priceInterval) return;

  fetchLivePrice().catch(() => {});

  priceInterval = setInterval(async () => {
    try {
      await fetchLivePrice();
    } catch (e) {
    }
  }, 2000);
}

export function stopPriceLoop() {
  if (priceInterval) {
    clearInterval(priceInterval);
    priceInterval = null;
  }
}
