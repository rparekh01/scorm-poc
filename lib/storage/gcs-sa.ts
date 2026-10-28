import type { StorageAdapter, StoredObject } from "./types";

// Reads objects from Google Cloud Storage with a service account JSON key (the file Google
// calls "type: service_account"). No HMAC key is needed.
//
//   1. Sign a short-lived JWT with the key's private_key (RS256, Web Crypto).
//   2. Send it to the key's token_uri; Google answers with an access token (about 1 hour).
//   3. Call the storage XML API with "Authorization: Bearer <token>".
//
// Only fetch and Web Crypto are used, so it runs on Node, Netlify and Cloudflare Workers alike.
// The official @google-cloud/storage library is not used: it is built for Node, not Workers.

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_S = 300; // get a new token this long before the old one expires

function loadKey(raw: string): ServiceAccountKey {
  let text = raw.trim();
  // Allow the JSON to be stored base64-encoded, which some secret stores prefer.
  if (!text.startsWith("{")) text = atob(text);
  const key = JSON.parse(text) as Partial<ServiceAccountKey> & { type?: string };
  if (key.type && key.type !== "service_account") throw new Error("GCP_SERVICE_ACCOUNT_JSON is not a service account key");
  if (!key.client_email || !key.private_key) throw new Error("GCP_SERVICE_ACCOUNT_JSON needs client_email and private_key");
  return {
    client_email: key.client_email,
    // Some secret stores keep the newlines in the key as the two characters \n. Turn them back.
    private_key: key.private_key.replace(/\\n/g, "\n"),
    token_uri: key.token_uri,
  };
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export function createGcsServiceAccountAdapter(): StorageAdapter {
  const bucket = process.env.GCS_BUCKET;
  const rawKey = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!bucket || !rawKey) throw new Error("GCS_BUCKET and GCP_SERVICE_ACCOUNT_JSON must be set");
  const key = loadKey(rawKey);
  const tokenUri = key.token_uri || DEFAULT_TOKEN_URI;
  // Overridable so tests can point at a local stand-in. Leave unset for real use.
  const apiBase = (process.env.GCS_API_BASE || "https://storage.googleapis.com").replace(/\/$/, "");

  let signingKey: Promise<CryptoKey> | undefined;
  let token: { value: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  async function requestToken(): Promise<string> {
    signingKey ??= importPrivateKey(key.private_key);
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64urlText(
      JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey, new TextEncoder().encode(`${header}.${claims}`));
    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${b64url(signature)}`,
      }),
    });
    // Never include the response body or the key in the error: keep secrets out of logs.
    if (!res.ok) throw new Error(`Google token request failed (${res.status})`);
    const out = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!out.access_token) throw new Error("Google token response had no access_token");
    token = { value: out.access_token, expiresAt: now + (out.expires_in ?? 3600) - REFRESH_MARGIN_S };
    return token.value;
  }

  // One refresh at a time, so a burst of requests on a cold start signs only once.
  async function accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && token && token.expiresAt > Date.now() / 1000) return token.value;
    refreshing ??= requestToken().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  const urlFor = (objectKey: string) => `${apiBase}/${bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;

  return {
    async getObject(objectKey, range): Promise<StoredObject | null> {
      const call = async (t: string) =>
        fetch(urlFor(objectKey), { headers: { authorization: `Bearer ${t}`, ...(range ? { Range: range } : {}) } });

      let res = await call(await accessToken());
      if (res.status === 401) res = await call(await accessToken(true)); // token revoked or expired early: retry once

      // Same as the HMAC adapter: a missing object, or one this account cannot see, is "not found".
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok && res.status !== 206) throw new Error(`GCS responded ${res.status}`);
      return {
        body: res.body,
        status: res.status === 206 ? 206 : 200,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        contentLength: res.headers.get("content-length") ?? undefined,
        contentRange: res.headers.get("content-range") ?? undefined,
        etag: res.headers.get("etag") ?? undefined,
      };
    },
  };
}
