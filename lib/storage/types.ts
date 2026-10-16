export interface StoredObject {
  body: ReadableStream<Uint8Array> | null;
  status: 200 | 206;
  contentType: string;
  contentLength?: string;
  contentRange?: string;
  etag?: string;
}

export interface StorageAdapter {
  /**
   * Fetch one object. Returns null when the object is not found.
   * Any other failure throws. `range` is the raw Range header, passed through.
   */
  getObject(key: string, range?: string | null): Promise<StoredObject | null>;
}
