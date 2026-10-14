/**
 * W30: pdf.js needs its worker script in the browser. The legacy build's worker is emitted as a
 * hashed asset by Vite (`?url`) and registered before any PDF (or PDF inside an .eml) is read.
 * In Node (unit tests) pdf.js uses its built-in fake worker, so nothing is configured there.
 */
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

let loaded: Promise<unknown> | undefined;

export function loadPdfJs(): Promise<unknown> | undefined {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return undefined;
  loaded ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return loaded;
}
