/// <reference lib="webworker" />
import { computeAnalysis, type Dataset } from '../services/analysis';

interface Request {
  id: number;
  dataset: Dataset;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, dataset } = e.data;
  try {
    const analysis = computeAnalysis(dataset);
    (self as unknown as Worker).postMessage({ id, analysis });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
