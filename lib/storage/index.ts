import type { StorageAdapter } from "./types";
import { createGcsAdapter } from "./gcs";
import { createLocalAdapter } from "./local";

let adapter: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (!adapter) {
    adapter = process.env.STORAGE_ADAPTER === "gcs" ? createGcsAdapter() : createLocalAdapter();
  }
  return adapter;
}
