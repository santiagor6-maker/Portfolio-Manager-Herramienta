import { b3MovimentacaoPreset, b3NegociacaoPreset, b3PosicaoPreset } from './b3';
import { canonicalPreset } from './canonical';
import type { PresetDefinition } from './common';
import { degiroAccountPreset, degiroTransactionsPreset } from './degiro';
import { etoroPreset } from './etoro';
import { fidelityPreset } from './fidelity';
import { extractoColombianoPreset } from './extracto-co';
import { genericPreset } from './generic';
import { ibkrActivityPreset, ibkrFlexPreset } from './ibkr';
import { notaCorretagemPreset } from './nota-corretagem';
import { schwabPreset } from './schwab';
import { trading212Preset } from './trading212';
import type { PresetInfo } from '../types';
import { PDF_PARSERS } from '../pdf/parsers';

/** All auto-detectable presets (the generic one is the fallback and is not auto-detected). */
export const PRESETS: PresetDefinition[] = [
  canonicalPreset,
  ibkrActivityPreset,
  ibkrFlexPreset,
  b3NegociacaoPreset,
  b3MovimentacaoPreset,
  b3PosicaoPreset,
  notaCorretagemPreset,
  schwabPreset,
  fidelityPreset,
  degiroTransactionsPreset,
  degiroAccountPreset,
  trading212Preset,
  etoroPreset,
  extractoColombianoPreset,
];

export function getPreset(id: string): PresetDefinition | undefined {
  return id === genericPreset.id ? genericPreset : PRESETS.find((p) => p.id === id);
}

/** Metadata for the UI (format picker, help texts), including PDF parsers. */
export function listPresets(): PresetInfo[] {
  const tabular = [...PRESETS, genericPreset].map(({ id, label, broker, country, fileKinds, confidence, description, exportHelp }) => ({
    id, label, broker, country, fileKinds, confidence, description, exportHelp,
  }));
  const pdf = PDF_PARSERS.map(({ id, label, broker, country, confidence, description, exportHelp }): PresetInfo => ({
    id, label, broker, country, fileKinds: ['pdf'], confidence, description, exportHelp,
  }));
  return [...tabular, ...pdf];
}
