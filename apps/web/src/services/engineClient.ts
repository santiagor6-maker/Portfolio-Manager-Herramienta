/**
 * Runs `computeAnalysis` off the main thread. Only the latest request matters: older
 * in-flight results are dropped so fast currency/portfolio switching never shows stale data.
 */
import { computeAnalysis, type Analysis, type Dataset } from './analysis';

type Pending = { resolve: (a: Analysis) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined' || import.meta.env?.MODE === 'test') {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; analysis?: Analysis; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.analysis) p.resolve(e.data.analysis);
      else p.reject(new Error(e.data.error ?? 'worker error'));
    };
    worker.onerror = () => {
      // Worker failed to boot (CSP, bundling): fall back to main-thread compute.
      worker?.terminate();
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('worker_failed'));
      }
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function isWorkerActive(): boolean {
  return !!worker;
}

export async function runAnalysis(dataset: Dataset): Promise<{ id: number; analysis: Analysis }> {
  const id = ++seq;
  const w = getWorker();
  if (!w) return { id, analysis: computeAnalysis(dataset) };
  try {
    const analysis = await new Promise<Analysis>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, dataset });
    });
    return { id, analysis };
  } catch {
    return { id, analysis: computeAnalysis(dataset) };
  }
}

export function latestRequestId(): number {
  return seq;
}
