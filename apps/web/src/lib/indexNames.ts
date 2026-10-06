/** Display names of rate/inflation indices (no imports: safe from any module). */
export const INDEX_NAMES: Record<string, string> = {
  CDI: 'CDI',
  SELIC: 'Selic',
  IPCA: 'IPCA',
  IPC_CO: 'IPC',
  IBR: 'IBR',
  UVR: 'UVR',
  CPI_US: 'CPI (EE. UU.)',
  HICP_EA: 'HICP (zona euro)',
};

/** Short display name of a rate/inflation index. */
export function indexName(id: string | undefined): string {
  if (!id) return '—';
  return INDEX_NAMES[id] ?? id;
}
