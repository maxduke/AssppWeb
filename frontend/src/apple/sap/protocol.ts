// SAP setup protocol: fetches the Apple certificate and performs the key
// exchange. Both endpoints are public Apple services (no credentials);
// requests travel through the wisp tunnel via appleRequest like every other
// Apple API call. Ported from ipatool's internal/sap/protocol.go.

import { appleRequest } from '../request';
import { buildPlist, parsePlist } from '../plist';
import { abortable, createDeadline } from '../../utils/abort';
import type { SapEndpoints } from './types';

const SETUP_CERTIFICATE_KEY = 'sign-sap-setup-cert';
const SETUP_BUFFER_KEY = 'sign-sap-setup-buffer';
const MAX_SETUP_BODY = 1 << 20;

function plistBytes(document: string, key: string): Uint8Array {
  const values = parsePlist(document) as Record<string, unknown>;
  const value = values[key];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new Error(`Apple plist is missing ${key}`);
  }
  return value;
}

export async function fetchSetupCertificate(
  endpoints: SapEndpoints,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const deadline = createDeadline(30_000, signal);
  try {
    const response = await abortable(
      () =>
        appleRequest({
          method: 'GET',
          signal: deadline.signal,
          host: new URL(endpoints.certificateURL).hostname,
          path: `${new URL(endpoints.certificateURL).pathname}${new URL(endpoints.certificateURL).search}`,
        }),
      deadline.signal,
    );
    if (response.status !== 200) {
      throw new Error(`SAP certificate request returned ${response.status}`);
    }
    if (response.body.length > MAX_SETUP_BODY) {
      throw new Error('SAP certificate response exceeds 1 MiB');
    }
    return plistBytes(response.body, SETUP_CERTIFICATE_KEY);
  } finally {
    deadline.dispose();
  }
}

export async function exchangeSetupBuffer(
  endpoints: SapEndpoints,
  input: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const envelope = buildPlist({ [SETUP_BUFFER_KEY]: input });
  const url = new URL(endpoints.setupURL);
  const deadline = createDeadline(30_000, signal);
  try {
    const response = await abortable(
      () =>
        appleRequest({
          method: 'POST',
          signal: deadline.signal,
          host: url.hostname,
          path: `${url.pathname}${url.search}`,
          headers: {
            'Content-Type': 'application/x-plist',
          },
          body: envelope,
        }),
      deadline.signal,
    );
    if (response.status !== 200) {
      throw new Error(`SAP setup exchange returned ${response.status}`);
    }
    if (response.body.length > MAX_SETUP_BODY) {
      throw new Error('SAP setup response exceeds 1 MiB');
    }
    return plistBytes(response.body, SETUP_BUFFER_KEY);
  } finally {
    deadline.dispose();
  }
}
