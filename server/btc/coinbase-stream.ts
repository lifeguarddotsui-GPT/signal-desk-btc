const FEED_URL = "wss://ws-feed.exchange.coinbase.com";
const PRODUCT_ID = "BTC-USD";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_FRAMES = 32;
const HEARTBEAT_TIMEOUT_MS = 12_000;
const HEARTBEAT_TRADE_GRACE_MS = 3_000;
const CONNECT_TIMEOUT_MS = 8_000;
const RECOVERY_TIMEOUT_MS = 5_000;
const FRAME_DECODE_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_MS = 60_000;
const REST_FALLBACK_SOURCE =
  "Coinbase Exchange REST fallback (bootstrap/recovery only; comparison only; not settlement oracle)";

export type CoinbaseTick = {
  price: number;
  asOf: string;
  source: string;
  eventId: string;
};

type SocketLike = {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

type Options = {
  readFallback: () => Promise<{ price: number; asOf: string; source?: string }>;
  onTick: (tick: CoinbaseTick) => void;
  onGap: (at: number, reason: string) => void;
  now?: () => number;
  random?: () => number;
  connect?: (url: string) => SocketLike;
};

/** A single bounded, reconnecting Coinbase Exchange feed for this process. */
export function createCoinbaseStream(options: Options) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const connect = options.connect ?? (url => new WebSocket(url) as unknown as SocketLike);
  let running = false;
  let socket: SocketLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimeout: ReturnType<typeof setTimeout> | undefined;
  const frameDecodeTimers = new Set<ReturnType<typeof setTimeout>>();
  let lastHeartbeatAt: number | null = null;
  let lastSequence: number | null = null;
  let lastTickerTime: number | null = null;
  let lastTradeId: number | null = null;
  let lastHeartbeatTradeId: number | null = null;
  let pendingHeartbeatTradeId: number | null = null;
  let pendingHeartbeatAt: number | null = null;
  let failures = 0;
  let pendingFrames = 0;
  let recovering = false;
  let recoveryQueued = false;
  let recoveryGeneration = 0;
  let lastRecoveryAt = -Infinity;
  let sessionTrusted = false;
  let websocketTicks = 0;
  let sessionId = 0;
  let frameQueue = Promise.resolve();
  const seenTradeIds = new Set<string>();
  const tradeIdQueue: string[] = [];

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (connectTimer) clearTimeout(connectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (recoveryTimeout) clearTimeout(recoveryTimeout);
    for (const timer of Array.from(frameDecodeTimers)) clearTimeout(timer);
    reconnectTimer = undefined;
    connectTimer = undefined;
    heartbeatTimer = undefined;
    recoveryTimeout = undefined;
    frameDecodeTimers.clear();
  }

  function rememberTrade(identity: string) {
    seenTradeIds.add(identity);
    tradeIdQueue.push(identity);
    while (tradeIdQueue.length > 4_096) seenTradeIds.delete(tradeIdQueue.shift()!);
  }

  function gap(reason: string) {
    options.onGap(now(), reason.slice(0, 180));
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    failures = Math.min(failures + 1, 16);
    const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** Math.min(failures - 1, 6));
    const delay = Math.floor(base * (0.75 + Math.max(0, Math.min(1, random())) * 0.5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
    reconnectTimer.unref?.();
  }

  function detachAndClose(current: SocketLike, reason: string) {
    if (socket !== current) return;
    socket = undefined;
    sessionTrusted = false;
    clearTimers();
    current.onopen = current.onmessage = current.onerror = current.onclose = null;
    try { current.close(1000, reason.slice(0, 120)); } catch { /* Already closed. */ }
    scheduleReconnect();
  }

  function distrustAndReconnect(current: SocketLike, reason: string) {
    if (socket !== current || !sessionTrusted) return;
    sessionTrusted = false;
    gap(reason);
    detachAndClose(current, reason);
  }

  async function recover(reason: string, force = false, emitGap = true) {
    if (emitGap) gap(reason);
    if (!running) return;
    if (recovering) {
      if (force) recoveryQueued = true;
      return;
    }
    if (!force && now() - lastRecoveryAt < 3_000) return;
    recovering = true;
    const generation = ++recoveryGeneration;
    lastRecoveryAt = now();
    const websocketTicksAtRequest = websocketTicks;
    const requestedSession = sessionId;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const fallback = await Promise.race([
        options.readFallback(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Coinbase REST recovery timed out")), RECOVERY_TIMEOUT_MS);
          recoveryTimeout = timeout;
          timeout.unref?.();
        }),
      ]);
      const sourceTime = Date.parse(fallback.asOf);
      if (!Number.isFinite(fallback.price) || fallback.price <= 0 ||
          !Number.isFinite(sourceTime) || now() - sourceTime > 20_000 || sourceTime > now() + 2_000) {
        throw new Error("Coinbase REST recovery returned invalid or stale data");
      }
      if (!running || requestedSession !== sessionId || websocketTicks > websocketTicksAtRequest) return;
      options.onTick({
        price: fallback.price, asOf: new Date(sourceTime).toISOString(),
        source: REST_FALLBACK_SOURCE,
        eventId: `rest:${new Date(sourceTime).toISOString()}:${fallback.price}`,
      });
    } catch (error) {
      if (running && requestedSession === sessionId)
        gap(error instanceof Error ? `Coinbase REST fallback unavailable: ${error.message}` :
          "Coinbase REST fallback unavailable");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (generation === recoveryGeneration) {
        if (recoveryTimeout === timeout) recoveryTimeout = undefined;
        recovering = false;
        if (recoveryQueued && running) {
          recoveryQueued = false;
          void recover("Coinbase stream recovery queued after a sequence discontinuity", true);
        }
      }
    }
  }

  function checkSequence(sequence: number, origin: "ticker" | "heartbeat"): boolean {
    if (lastSequence !== null) {
      if (sequence < lastSequence) {
        if (socket) distrustAndReconnect(socket,
          `Coinbase ${origin} out of order: sequence ${sequence} after ${lastSequence}`);
        return true;
      }
    }
    lastSequence = Math.max(lastSequence ?? sequence, sequence);
    return false;
  }

  function payloadSize(data: unknown): number | null {
    if (typeof data === "string") return Buffer.byteLength(data);
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
    return null;
  }

  async function decodeFrame(data: unknown): Promise<string | null> {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data))
      return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          data.text(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Coinbase frame decode timed out")),
              FRAME_DECODE_TIMEOUT_MS);
            frameDecodeTimers.add(timeout);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
          frameDecodeTimers.delete(timeout);
        }
      }
    }
    return null;
  }

  async function handleFrame(data: unknown, current: SocketLike) {
    if (!running || socket !== current) return;
    const size = payloadSize(data);
    if (size === null || size > MAX_FRAME_BYTES) {
      distrustAndReconnect(current,
        size === null ? "Coinbase frame has unsupported format" : "Coinbase frame exceeded 64 KiB limit");
      return;
    }
    let message: Record<string, unknown>;
    try {
      const decoded = await decodeFrame(data);
      if (decoded === null) throw new Error("unsupported frame");
      const parsed: unknown = JSON.parse(decoded);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid message object");
      message = parsed as Record<string, unknown>;
    } catch {
      distrustAndReconnect(current, "Coinbase sent an invalid JSON frame");
      return;
    }
    if (!running || socket !== current) return;

    if (message.type === "subscriptions") return;
    if (message.type === "error") {
      distrustAndReconnect(current, `Coinbase WebSocket error: ${String(message.message ?? "unspecified error")}`);
      return;
    }
    if (message.product_id !== PRODUCT_ID) return;
    if (message.type === "heartbeat") {
      const sequence = message.sequence;
      if (!Number.isSafeInteger(sequence) || Number(sequence) < 0 ||
          !Number.isSafeInteger(message.last_trade_id) || Number(message.last_trade_id) < 0) {
        distrustAndReconnect(current, "Coinbase heartbeat invalid: missing sequence or last_trade_id");
        return;
      }
      lastHeartbeatAt = now();
      if (checkSequence(Number(sequence), "heartbeat")) return;
      const heartbeatTradeId = Number(message.last_trade_id);
      if (lastHeartbeatTradeId !== null && heartbeatTradeId < lastHeartbeatTradeId) {
        distrustAndReconnect(current,
          `Coinbase heartbeat last_trade_id out of order: ${heartbeatTradeId} after ${lastHeartbeatTradeId}`);
        return;
      }
      if (lastHeartbeatTradeId !== null && heartbeatTradeId > lastHeartbeatTradeId &&
          (lastTradeId === null || lastTradeId < heartbeatTradeId)) {
        if (pendingHeartbeatTradeId === null) pendingHeartbeatAt = now();
        pendingHeartbeatTradeId = heartbeatTradeId;
      }
      lastHeartbeatTradeId = heartbeatTradeId;
      failures = 0;
      return;
    }
    if (message.type !== "ticker") return;
    const price = Number(message.price);
    const sequence = message.sequence;
    const tradeId = message.trade_id;
    const sourceTime = typeof message.time === "string" ? Date.parse(message.time) : NaN;
    if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(sequence) ||
        Number(sequence) < 0 || !Number.isSafeInteger(tradeId) || Number(tradeId) < 0 ||
        !Number.isFinite(sourceTime)) {
      distrustAndReconnect(current, "Coinbase ticker invalid: price, time, trade_id, or sequence is malformed");
      return;
    }
    const identity = `${PRODUCT_ID}:${tradeId}`;
    if (seenTradeIds.has(identity)) return;
    if (now() - sourceTime > 20_000 || sourceTime > now() + 2_000) {
      distrustAndReconnect(current, "Coinbase ticker stale or future-dated; reconnecting");
      return;
    }
    if (lastTickerTime !== null && sourceTime < lastTickerTime) {
      distrustAndReconnect(current, "Coinbase ticker event time out of order; reconnecting");
      return;
    }
    if (lastTradeId !== null && Number(tradeId) < lastTradeId) {
      distrustAndReconnect(current,
        `Coinbase ticker trade_id out of order: ${tradeId} after ${lastTradeId}; reconnecting`);
      return;
    }
    if (checkSequence(Number(sequence), "ticker")) return;
    lastTickerTime = sourceTime;
    lastTradeId = Math.max(lastTradeId ?? Number(tradeId), Number(tradeId));
    if (pendingHeartbeatTradeId !== null && Number(tradeId) >= pendingHeartbeatTradeId) {
      pendingHeartbeatTradeId = null;
      pendingHeartbeatAt = null;
    }
    rememberTrade(identity);
    failures = 0;
    websocketTicks++;
    options.onTick({
      price, asOf: new Date(sourceTime).toISOString(),
      source: "Coinbase comparison only (not settlement oracle)",
      eventId: identity,
    });
  }

  function open() {
    if (!running || socket) return;
    sessionId++;
    // Sequence continuity applies to a single live Exchange feed session.
    lastSequence = null;
    lastTickerTime = null;
    lastTradeId = null;
    lastHeartbeatTradeId = null;
    pendingHeartbeatTradeId = null;
    pendingHeartbeatAt = null;
    websocketTicks = 0;
    let current: SocketLike;
    try {
      current = connect(FEED_URL);
      socket = current;
    } catch (error) {
      gap(`Coinbase WebSocket connection failed: ${error instanceof Error ? error.message : "unknown error"}`);
      scheduleReconnect();
      return;
    }
    connectTimer = setTimeout(() => {
      if (socket === current) detachAndClose(current, "connection timeout");
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    current.onopen = () => {
      if (socket !== current || !running) return;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
      try {
        const subscription = JSON.stringify({
          type: "subscribe",
          product_ids: [PRODUCT_ID],
           channels: ["ticker", "heartbeat"],
        });
        if (current.bufferedAmount > MAX_FRAME_BYTES) throw new Error("outbound WebSocket buffer limit exceeded");
        current.send(subscription);
      } catch (error) {
        gap(`Coinbase subscription failed: ${error instanceof Error ? error.message : "unknown error"}`);
        detachAndClose(current, "subscription failed");
        return;
      }
      sessionTrusted = true;
      lastHeartbeatAt = now();
      heartbeatTimer = setInterval(() => {
        if (socket === current && pendingHeartbeatTradeId !== null && pendingHeartbeatAt !== null &&
            now() - pendingHeartbeatAt >= HEARTBEAT_TRADE_GRACE_MS) {
          distrustAndReconnect(current,
            `Coinbase heartbeat last_trade_id ${pendingHeartbeatTradeId} had no matching ticker within grace; reconnecting`);
          return;
        }
        if (socket === current && lastHeartbeatAt !== null &&
            now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          gap("Coinbase heartbeat timed out; comparison feed is stale");
          detachAndClose(current, "heartbeat timeout");
        }
      }, 1_000);
      heartbeatTimer.unref?.();
      void recover("Coinbase REST bootstrap fallback while WebSocket feed initializes", true, false);
    };
    current.onmessage = event => {
      if (socket !== current) return;
      const size = payloadSize(event.data);
      if (size === null || size > MAX_FRAME_BYTES) {
        distrustAndReconnect(current,
          size === null ? "Coinbase frame has unsupported format" : "Coinbase frame exceeded 64 KiB limit");
        return;
      }
      if (pendingFrames >= MAX_PENDING_FRAMES) {
        distrustAndReconnect(current, "Coinbase frame processing buffer limit exceeded");
        return;
      }
      pendingFrames++;
      frameQueue = frameQueue.then(() => handleFrame(event.data, current)).catch(error => {
        if (socket === current) distrustAndReconnect(current,
          `Coinbase frame processing failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }).finally(() => { pendingFrames = Math.max(0, pendingFrames - 1); });
    };
    current.onerror = () => {
      if (socket === current) {
        gap("Coinbase WebSocket transport error");
        detachAndClose(current, "transport error");
      }
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = undefined;
      sessionTrusted = false;
      clearTimers();
      if (running) {
        gap("Coinbase WebSocket disconnected");
        scheduleReconnect();
      }
    };
  }

  function start() {
    if (running) return;
    running = true;
    open();
  }

  function stop() {
    if (!running && !socket) {
      clearTimers();
      return;
    }
    running = false;
    sessionId++;
    recoveryGeneration++;
    clearTimers();
    const current = socket;
    socket = undefined;
    if (current) {
      sessionTrusted = false;
      current.onopen = current.onmessage = current.onerror = current.onclose = null;
      try { current.close(1000, "feed stopped"); } catch { /* Already closed. */ }
    }
    pendingFrames = 0;
    recovering = false;
    recoveryQueued = false;
    frameQueue = Promise.resolve();
  }

  return { start, stop };
}