import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { MLS_RUNTIME_SCRIPT } from './runtime.generated';
import { setMLSTransport } from './runtime';

// All code and WASM are bundled with the application. This document has no
// navigation, network access, local-file access or third-party JavaScript.
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'none'; img-src 'none'; style-src 'none'"><script>${MLS_RUNTIME_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>`;
export default function RuntimeHost() {
  const ref = useRef<WebView>(null);
  const pending = useRef(new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; chunks?: Map<number, string>; total?: number }>());
  const sequence = useRef(0);
  useEffect(() => () => {
    setMLSTransport(null);
    for (const p of pending.current.values()) { clearTimeout(p.timer); p.reject(new Error('MLS runtime closed')); }
    pending.current.clear();
  }, []);
  return <View style={{ position: 'absolute', width: 1, height: 1, left: -100, overflow: 'hidden' }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <WebView ref={ref} source={{ html, baseUrl: 'https://ghostel.invalid/' }}
      originWhitelist={['about:blank', 'https://ghostel.invalid']}
      onShouldStartLoadWithRequest={r => r.url === 'about:blank' || r.url === 'https://ghostel.invalid/'}
      javaScriptEnabled domStorageEnabled={false} allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never" setSupportMultipleWindows={false}
      onMessage={event => {
        let message: any;
        try { message = JSON.parse(event.nativeEvent.data); } catch { return; }
        if (message.ready === true) {
          setMLSTransport(input => new Promise((resolve, reject) => {
            const id = ++sequence.current;
            const timer = setTimeout(() => { pending.current.delete(id); reject(new Error('MLS runtime timeout')); }, 30000);
            pending.current.set(id, { resolve, reject, timer });
            const total = Math.ceil(input.length / 65536);
            for (let part = 0; part < total; part++) ref.current?.injectJavaScript(`globalThis.receiveMLSChunk(${JSON.stringify({ id, part, total, chunk: input.slice(part * 65536, (part + 1) * 65536) })}); true;`);
          }));
          return;
        }
        const job = pending.current.get(message.id);
        if (!job) return;
        if (message.chunked === true) {
          if (!Number.isInteger(message.total) || message.total < 1 || message.total > 1024 || !Number.isInteger(message.part) || message.part < 0 || message.part >= message.total || typeof message.chunk !== 'string' || message.chunk.length > 65536) return;
          job.chunks ||= new Map(); job.total ??= message.total;
          if (job.total !== message.total || job.chunks.has(message.part)) return;
          job.chunks.set(message.part, message.chunk);
          if (job.chunks.size !== job.total) return;
          try { message = JSON.parse(Array.from({ length: job.total }, (_, i) => job.chunks!.get(i)).join('')); } catch { return; }
        }
        clearTimeout(job.timer); pending.current.delete(message.id);
        if (typeof message.result === 'string') job.resolve(message.result);
        else job.reject(new Error('MLS runtime failed'));
      }} />
  </View>;
}
