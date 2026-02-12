import EventEmitter from "events";

export type PriceTick = {
  symbol: "SUI";
  pyth: { price: number; conf?: number; publishTime?: number } | null;
  sudo: { price: number; ts: number } | null;
  blended: number;
  ts: number;
};

export const priceBus = new EventEmitter();
priceBus.setMaxListeners(100);

const state: { last?: PriceTick } = {};

const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PYTH_SUI_FEED_ID = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";

function median(nums: number[]) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function blendPrice(pythPrice: number, sudoPrice?: number) {
  if (!sudoPrice) return pythPrice;
  const diff = Math.abs(sudoPrice - pythPrice) / pythPrice;
  const tolerance = 0.006;
  if (diff > tolerance) return pythPrice;
  return median([pythPrice, sudoPrice]);
}

async function fetchPythSui(): Promise<{ price: number; conf?: number; publishTime?: number }> {
  const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${encodeURIComponent(PYTH_SUI_FEED_ID)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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

async function fetchSudoSui(): Promise<{ price: number; ts: number }> {
  const url = process.env.SUDO_PRICE_URL;
  if (!url) throw new Error("SUDO_PRICE_URL not set");

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`sudo http ${res.status}`);
  const json = await res.json();

  const price = Number(json.price);
  if (!Number.isFinite(price)) throw new Error("sudo price invalid");
  return { price, ts: Date.now() };
}

let fallbackPrice = 3.85;

export async function fetchLivePrice(): Promise<PriceTick> {
  const [pythResult, sudoResult] = await Promise.allSettled([fetchPythSui(), fetchSudoSui()]);

  const pythOk = pythResult.status === "fulfilled" ? pythResult.value : null;
  const sudoOk = sudoResult.status === "fulfilled" ? sudoResult.value : null;

  let blended: number;

  if (pythOk) {
    blended = blendPrice(pythOk.price, sudoOk?.price);
    fallbackPrice = blended;
  } else if (sudoOk) {
    blended = sudoOk.price;
    fallbackPrice = blended;
  } else {
    const drift = (Math.random() - 0.48) * 0.008;
    fallbackPrice = Math.max(2.0, Math.min(8.0, fallbackPrice + drift));
    blended = fallbackPrice;
  }

  const tick: PriceTick = {
    symbol: "SUI",
    pyth: pythOk,
    sudo: sudoOk,
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
