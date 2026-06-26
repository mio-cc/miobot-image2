import type { PackageDescriptor } from '@miobot-v2/shared';

export const STORAGE_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/storage',
  phase: 'P4-storage',
};

export { writeFileAtomicSync, writeJsonAtomicSync, readJsonSync, fileExists } from './atomic.js';
export { DebouncedWriter } from './debounce.js';
export { FileJsonStore, InMemoryJsonStore, type JsonStore, type FileJsonStoreOptions } from './json-store.js';
export { ConfigStore, type ConfigStoreOptions } from './config-store.js';
export { CanvasStateStore, type CanvasStateStoreOptions } from './canvas-state.js';
export { LogFileStore, filterLogRecords, mergeLogRecords } from './log-store.js';
