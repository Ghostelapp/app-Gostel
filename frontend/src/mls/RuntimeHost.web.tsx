import { useEffect } from 'react';
import { MLS_RUNTIME_SCRIPT } from './runtime.generated';
import { setMLSTransport } from './runtime';
export default function RuntimeHost() {
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([MLS_RUNTIME_SCRIPT], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let sequence = 0;
    worker.onmessage = ({ data }) => {
      if (data.ready === true) {
        setMLSTransport(input => new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('MLS runtime timeout')); }, 30000);
          pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, input });
        }));
      } else {
        const job = pending.get(data.id); if (!job) return;
        clearTimeout(job.timer); pending.delete(data.id);
        if (typeof data.result === 'string') job.resolve(data.result); else job.reject(new Error('MLS runtime failed'));
      }
    };
    return () => {
      setMLSTransport(null); worker.terminate(); URL.revokeObjectURL(url);
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('MLS runtime closed')); }
    };
  }, []);
  return null;
}
