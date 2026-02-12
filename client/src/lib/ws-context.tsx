import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";

type WSHandler = (data: any) => void;
type WSMessage = { type: string; data: any };

interface WSContextValue {
  connected: boolean;
  subscribe: (type: string, handler: WSHandler) => () => void;
  lastPrice: any | null;
}

const WSContext = createContext<WSContextValue>({
  connected: false,
  subscribe: () => () => {},
  lastPrice: null,
});

export function WSProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<WSHandler>>>(new Map());
  const [connected, setConnected] = useState(false);
  const [lastPrice, setLastPrice] = useState<any>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === "price") setLastPrice(msg.data);

        const handlers = handlersRef.current.get(msg.type);
        if (handlers) handlers.forEach((h) => h(msg.data));
      } catch (e) {}
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((type: string, handler: WSHandler) => {
    if (!handlersRef.current.has(type)) handlersRef.current.set(type, new Set());
    handlersRef.current.get(type)!.add(handler);
    return () => { handlersRef.current.get(type)?.delete(handler); };
  }, []);

  return (
    <WSContext.Provider value={{ connected, subscribe, lastPrice }}>
      {children}
    </WSContext.Provider>
  );
}

export function useWS() {
  return useContext(WSContext);
}

export function useLivePrice() {
  const { lastPrice } = useWS();
  return lastPrice;
}
