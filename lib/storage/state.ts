/**
 * Module-scoped storage state and the single shared mutex that serializes
 * every read-modify-write against the accounts files.
 *
 * Split out of `lib/storage.ts` in RC-2 so the identity helpers, normalize,
 * load/save, flagged, and export-import modules can all share the same
 * resolved path and the same lock without creating circular imports.
 *
 * Invariants this module preserves:
 *   - `currentStoragePath` is either `null` (use global fallback) or an
 *     absolute path to a project-scoped accounts file.
 *   - `currentProjectRoot` is only non-null when `currentStoragePath` is
 *     project-scoped; `setStoragePathDirect` deliberately clears it so
 *     ad-hoc overrides (tests, one-off CLI paths) never look like a real
 *     project.
 *   - `withStorageLock` chains every critical section through a single
 *     promise so nothing can interleave between a load and its paired save.
 */

import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ACCOUNTS_FILE_NAME, LEGACY_ACCOUNTS_FILE_NAME } from "../constants.js";
import {
  findProjectRoot,
  getConfigDir,
  getProjectConfigDir,
  getProjectGlobalConfigDir,
  getProjectStorageKey,
} from "./paths.js";

let storageMutex: Promise<void> = Promise.resolve();

/**
 * Serializes storage I/O to keep account file reads/writes lock-step and avoid
 * cross-request races during migration/seeding flows.
 */
export function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousMutex = storageMutex;
  let releaseLock: () => void;
  storageMutex = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  return previousMutex.then(fn).finally(() => releaseLock());
}

function newStorageState() {
  return {
    currentStoragePath: null as string | null,
    currentLegacyProjectStoragePath: null as string | null,
    currentProjectRoot: null as string | null,
    storagePathListeners: new Set<() => void>(),
  };
}
const defaultState = newStorageState();
const storageScope = new AsyncLocalStorage<ReturnType<typeof newStorageState>>();
const state = () => storageScope.getStore() ?? defaultState;

/** V2 hosts multiple locations in one process. Timers inherit their owner's scope. */
export function createStorageScope() {
  const scoped = newStorageState();
  return <T>(operation: () => T): T => storageScope.run(scoped, operation);
}

export function subscribeToStoragePathChanges(listener: () => void): () => void {
  const { storagePathListeners } = state();
  storagePathListeners.add(listener);
  return () => { storagePathListeners.delete(listener); };
}

function notifyStoragePathChanged(): void {
  for (const listener of state().storagePathListeners) listener();
}

export function setStoragePath(projectPath: string | null): void {
  const current = state();
  if (!projectPath) {
    current.currentStoragePath = null;
    current.currentLegacyProjectStoragePath = null;
    current.currentProjectRoot = null;
    notifyStoragePathChanged();
    return;
  }

  const projectRoot = findProjectRoot(projectPath);
  if (projectRoot) {
    current.currentProjectRoot = projectRoot;
    current.currentStoragePath = join(getProjectGlobalConfigDir(projectRoot), ACCOUNTS_FILE_NAME);
    current.currentLegacyProjectStoragePath = join(getProjectConfigDir(projectRoot), LEGACY_ACCOUNTS_FILE_NAME);
  } else {
    current.currentStoragePath = null;
    current.currentLegacyProjectStoragePath = null;
    current.currentProjectRoot = null;
  }
  notifyStoragePathChanged();
}

export function setStoragePathDirect(path: string | null): void {
  const current = state();
  current.currentStoragePath = path;
  current.currentLegacyProjectStoragePath = null;
  current.currentProjectRoot = null;
  notifyStoragePathChanged();
}

/**
 * Returns the file path for the account storage JSON file.
 * @returns Absolute path to the accounts.json file
 */
export function getStoragePath(): string {
  const { currentStoragePath } = state();
  if (currentStoragePath) {
    return currentStoragePath;
  }
  return join(getConfigDir(), ACCOUNTS_FILE_NAME);
}

// Internal accessors used by sibling storage modules. Not re-exported from the
// top-level barrel: callers outside `lib/storage/` should use the public
// `setStoragePath` / `getStoragePath` APIs.

export function getCurrentStoragePath(): string | null {
  return state().currentStoragePath;
}

export function getCurrentLegacyProjectStoragePath(): string | null {
  return state().currentLegacyProjectStoragePath;
}

export function getCurrentProjectRoot(): string | null {
  return state().currentProjectRoot;
}

/**
 * Returns the project storage key (e.g. `my-project-abc123def456`) that the
 * active project storage path is rooted under, or `null` when no per-project
 * root is active (global storage is in use). Used by the opt-in keychain
 * backend as the account identifier so each project's credentials live
 * under a distinct (service, account) pair in the OS keychain.
 *
 * When `setStoragePathDirect` overrode the path to something outside the
 * standard per-project layout (tests, custom CLI override), we fall back to
 * `null` because there is no meaningful project identity to key off.
 */
export function getCurrentProjectStorageKey(): string | null {
  const { currentProjectRoot } = state();
  if (!currentProjectRoot) return null;
  return getProjectStorageKey(currentProjectRoot);
}
