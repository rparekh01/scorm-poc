import type { StorageAdapter } from "./types";
import { createLocalAdapter } from "./local";
import { createGcsServiceAccountAdapter } from "./gcs-sa";
import { createGcsAdapter } from "./gcs";

let adapter: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (!adapter) {
    switch (process.env.STORAGE_ADAPTER) {
      case "gcs":
        adapter = createGcsAdapter();
        break;
      case "gcs-sa":
        adapter = createGcsServiceAccountAdapter();
        console.log("running gcs-sa");
        break;
      default:
        adapter = createLocalAdapter();
    }
  }
  return adapter;
}
