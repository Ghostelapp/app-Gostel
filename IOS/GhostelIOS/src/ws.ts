import { useEffect, useRef, useCallback } from 'react';
import { api, BASE_URL } from './api';

type Listener = (msg: any) => void;

export function useWebSocket(onMessage: Listener, enabled: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const listenerRef = useRef<Listener>(onMessage);
  listenerRef.current = onMessage;

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let reconnectTimer: any = null;

    const connect = async () => {
      if (cancelled) return;
      try {
        const { data } = await api.post('/ws-ticket');
        if (!data?.ticket || cancelled) return;
        const base = BASE_URL.replace(/^http/, 'ws');
        const url = `${base}/api/ws?ticket=${encodeURIComponent(data.ticket)}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            listenerRef.current(data);
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => {
          wsRef.current = null;
          if (!cancelled) {
            reconnectTimer = setTimeout(connect, 3000);
          }
        };
        ws.onerror = () => {
          try {
            ws.close();
          } catch {}
        };
      } catch {
        if (!cancelled) reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled]);

  return { send };
}
