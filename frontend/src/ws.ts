import { useEffect, useRef, useCallback } from 'react';
import { getStoredToken } from './tokenStorage';
import { api } from './api';

type Listener = (msg: any) => void;

export function useWebSocket(onMessage: Listener, enabled: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const listenerRef = useRef<Listener>(onMessage);
  const queueRef = useRef<any[]>([]);
  listenerRef.current = onMessage;

  const send = useCallback((data: any) => {
    const isCallSignal =
      typeof data?.type === 'string' &&
      data.type.startsWith('call:') &&
      data.call_id &&
      data.to;
    if (isCallSignal) {
      data = {
        ...data,
        signal_id: data.signal_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      api.post(`/calls/${data.call_id}/signals`, data).catch(() => {});
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return;
    }
    // Signaling messages (especially early ICE candidates) must not disappear
    // while the socket is still connecting or briefly reconnecting.
    queueRef.current.push(data);
    if (queueRef.current.length > 200) queueRef.current.shift();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let reconnectTimer: any = null;
    let pingTimer: any = null;

    const connect = async () => {
      const token = await getStoredToken();
      if (!token || cancelled) return;
      const base = (process.env.EXPO_PUBLIC_BACKEND_URL || 'http://192.168.88.9:8000').replace(/^http/, 'ws');
      const url = `${base}/api/ws?token=${encodeURIComponent(token)}`;
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => {
          const queued = queueRef.current;
          queueRef.current = [];
          for (let index = 0; index < queued.length; index += 1) {
            try {
              ws.send(JSON.stringify(queued[index]));
            } catch {
              queueRef.current = [
                ...queued.slice(index),
                ...queueRef.current,
              ].slice(-200);
              break;
            }
          }
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 20_000);
        };
        ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            listenerRef.current(data);
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => {
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
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
      if (pingTimer) clearInterval(pingTimer);
      wsRef.current?.close();
      wsRef.current = null;
      queueRef.current = [];
    };
  }, [enabled]);

  return { send };
}
