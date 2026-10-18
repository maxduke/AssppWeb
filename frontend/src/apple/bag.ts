import { authHeaders } from '../api/client';
import { parsePlist } from './plist';
import type { SapEndpoints } from './sap/types';

export interface BagOutput {
  authURL: string;
  redownloadURL?: string;
  updateURL?: string;
  /** Present when the bag advertises the SAP signing protocol. */
  sapEndpoints?: SapEndpoints;
}

export const defaultAuthURL =
  'https://auth.itunes.apple.com/auth/v1/native/fast/';

const NATIVE_AUTH_HOST = 'auth.itunes.apple.com';

// The bag advertises the native auth endpoint without the /fast/ sub-path that
// the login flow requires; the no-trailing-slash variant 301s to an HTML page.
// Legacy Store endpoints also need a trailing slash, including pod redirects.
export function normalizeAuthURL(rawURL: string): string {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (
    /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname) &&
    /^\/WebObjects\/MZFinance\.woa\/wa\/authenticate\/*$/.test(url.pathname)
  ) {
    url.pathname = '/WebObjects/MZFinance.woa/wa/authenticate/';
    return url.toString();
  }
  if (url.hostname !== NATIVE_AUTH_HOST) {
    return rawURL;
  }
  if (/^\/auth\/v1\/native(?:\/fast)?\/*$/.test(url.pathname)) {
    url.pathname = '/auth/v1/native/fast/';
  }
  return url.toString();
}

// A signed credential body may only be sent to the known authentication APIs.
export function authEndpoint(rawURL: string, base?: URL): URL {
  const url = new URL(normalizeAuthURL(new URL(rawURL, base).toString()));
  const native =
    url.hostname === NATIVE_AUTH_HOST &&
    url.pathname === '/auth/v1/native/fast/';
  const legacy =
    /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(url.hostname) &&
    url.pathname === '/WebObjects/MZFinance.woa/wa/authenticate/';
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    (!native && !legacy)
  ) {
    throw new Error('Invalid Apple authentication endpoint');
  }
  return url;
}

// Fetches the bag via the backend proxy.
// The backend fetches it using Node.js native HTTPS.
// The bag response is public data (Apple service URLs, no credentials).
export async function fetchBag(deviceId: string): Promise<BagOutput> {
  try {
    const resp = await fetch(`/api/bag?guid=${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.warn(
        `[Bag] Proxy request failed, using default auth endpoint: ${err.error || `HTTP ${resp.status}`}`,
      );
      return { authURL: defaultAuthURL };
    }

    const xml = await resp.text();
    const dict = parsePlist(xml) as Record<string, any>;

    // authenticateAccount used to live inside the urlBag dict; newer bag
    // responses move it to the plist root, so prefer the root and fall back.
    const urlBag = dict.urlBag as Record<string, any> | undefined;
    const authURL =
      (dict.authenticateAccount as string | undefined) ??
      (urlBag?.authenticateAccount as string | undefined);

    const bagValue = (key: string): unknown => dict[key] ?? urlBag?.[key];
    const downloadURLs = {
      redownloadURL: bagValue('redownloadProduct') as string | undefined,
      updateURL: bagValue('updateProduct') as string | undefined,
    };

    const setupURL = bagValue('sign-sap-setup');
    const certificateURL = bagValue('sign-sap-setup-cert');
    const versionText = bagValue('sign-sap-version');
    let sapEndpoints: SapEndpoints | undefined;
    if (
      typeof setupURL === 'string' &&
      typeof certificateURL === 'string' &&
      (typeof versionText === 'string' || typeof versionText === 'number')
    ) {
      const version = Number(versionText);
      if (Number.isInteger(version) && version > 0) {
        sapEndpoints = { setupURL, certificateURL, version };
      }
    }

    if (!authURL) {
      console.warn(
        '[Bag] authenticateAccount URL not found in bag, using default auth endpoint',
      );
      return { authURL: defaultAuthURL, sapEndpoints, ...downloadURLs };
    }

    return {
      authURL: normalizeAuthURL(authURL),
      sapEndpoints,
      ...downloadURLs,
    };
  } catch (error) {
    console.warn(
      `[Bag] Failed to fetch/parse bag, using default auth endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { authURL: defaultAuthURL };
  }
}
