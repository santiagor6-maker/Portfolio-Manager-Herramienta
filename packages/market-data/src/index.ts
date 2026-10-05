/**
 * @pm/market-data — prices, FX and instrument search for Portafolio Pro.
 *
 * Entry points:
 *  - `MarketDataService` (server side): providers + cache + catalog + FX router.
 *  - `@pm/market-data/client` (browser): typed client for the apps/server HTTP API.
 */
export * from './types';
export * from './errors';
export * from './dates';
export * from './series';
export * from './symbols';
export * from './http';
export * from './cache';
export * from './catalog';
export * from './fx-router';
export * from './service';
export * from './providers/types';
export * from './providers/yahoo';
export * from './providers/banrep';
export * from './providers/bcb';
export * from './providers/ecb';
