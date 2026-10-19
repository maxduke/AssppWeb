import { authEndpoint, fetchBag } from './bag';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest } from './request';
import { abortable, abortableDelay, createDeadline } from '../utils/abort';
import { authenticationTimeoutMs } from './config';
import i18n from '../i18n';
import type { Account, Cookie } from '../types';

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface AuthRetry {
  status: number;
  attempt: number;
  attempts: number;
  delayMs: number;
}

const AUTH_REQUEST_ATTEMPTS = 3;
const MAX_REDIRECTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

function retryAfterMs(header?: string): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function sendWithTransientRetry(
  send: () => ReturnType<typeof appleRequest>,
  signal: AbortSignal,
  onRetry?: (retry: AuthRetry) => void,
) {
  const statuses: number[] = [];
  for (;;) {
    const response = await abortable(send, signal);
    // A valid Apple business response takes precedence over the HTTP status.
    // Replaying it can hide a verification/credential failure behind 5xx.
    const values = responseDictionary(response.body);
    if (
      values &&
      (values.failureType ||
        values.customerMessage ||
        values.dialog?.explanation ||
        values.accountInfo)
    ) {
      return response;
    }
    if (
      ![204, 404, 429].includes(response.status) &&
      Math.floor(response.status / 100) !== 5
    )
      return response;

    statuses.push(response.status);
    if (statuses.length === AUTH_REQUEST_ATTEMPTS) {
      throw new AuthenticationError(
        i18n.t('errors.auth.transientFailure', {
          attempts: AUTH_REQUEST_ATTEMPTS,
          statuses: statuses.join(', '),
        }),
      );
    }
    const requested = retryAfterMs(response.headers['retry-after']);
    if (requested !== undefined && requested > MAX_RETRY_DELAY_MS) {
      throw new AuthenticationError(
        i18n.t('errors.auth.retryLater', {
          seconds: Math.ceil(requested / 1000),
        }),
      );
    }
    const delayMs =
      requested === undefined
        ? 10_000 * 2 ** (statuses.length - 1)
        : Math.max(1000, requested);
    onRetry?.({
      status: response.status,
      attempt: statuses.length + 1,
      attempts: AUTH_REQUEST_ATTEMPTS,
      delayMs,
    });
    await abortableDelay(delayMs, signal);
  }
}

function responseDictionary(body: string): Record<string, any> | undefined {
  if (!body.trim()) return undefined;
  try {
    const values = parsePlist(body);
    return values && typeof values === 'object' && !Array.isArray(values)
      ? values
      : undefined;
  } catch {
    return undefined;
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId = '',
  onRetry?: (retry: AuthRetry) => void,
  signal?: AbortSignal,
): Promise<Account> {
  const deadline = createDeadline(
    authenticationTimeoutMs,
    signal,
    i18n.t('errors.auth.timeout'),
  );
  try {
    return await abortable(
      () =>
        authenticateWithSignal(
          email,
          password,
          code,
          existingCookies,
          deviceId,
          onRetry,
          deadline.signal,
        ),
      deadline.signal,
    );
  } finally {
    deadline.dispose();
  }
}

async function authenticateWithSignal(
  email: string,
  password: string,
  code: string | undefined,
  existingCookies: Cookie[] | undefined,
  deviceId: string,
  onRetry: ((retry: AuthRetry) => void) | undefined,
  signal: AbortSignal,
): Promise<Account> {
  let cookies = [...(existingCookies ?? [])];
  let storeFront = '';
  let pod: string | undefined;
  const bag = await abortable(() => fetchBag(deviceId, signal), signal);
  if (!bag.sapEndpoints) {
    throw new AuthenticationError(i18n.t('errors.auth.missingSigningConfig'));
  }
  let endpoint = authEndpoint(bag.authURL);
  endpoint.searchParams.set('guid', deviceId);
  const { signWithSap } = await abortable(() => import('./sap/client'), signal);
  // Serialize once per credential attempt. Redirects and transient retries
  // reuse the exact same bytes; only an explicit -5000 advances the attempt.
  let attempt = 1;
  const serialize = () =>
    buildPlist({
      appleId: email,
      attempt: String(attempt),
      guid: deviceId,
      password: code ? `${password}${code}` : password,
      rmp: '0',
      why: 'signIn',
    });
  let plistBody = serialize();
  let bodyBytes = new TextEncoder().encode(plistBody);
  let redirects = 0;

  for (;;) {
    const response = await sendWithTransientRetry(
      async () => {
        const signature = await abortable(
          () => signWithSap(deviceId, bag.sapEndpoints!, bodyBytes, signal),
          signal,
        );
        const sent = await abortable(
          () =>
            appleRequest({
              method: 'POST',
              host: endpoint.hostname,
              path: endpoint.pathname + endpoint.search,
              headers: {
                'Content-Type': 'application/x-apple-plist',
                'X-Apple-ActionSignature': signature,
              },
              body: plistBody,
              cookies,
              signal,
            }),
          signal,
        );
        cookies = extractAndMergeCookies(sent.rawHeaders, cookies);
        return sent;
      },
      signal,
      onRetry,
    );

    storeFront =
      response.headers['x-set-apple-store-front']?.split('-')[0] || storeFront;
    pod = response.headers.pod || pod;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) {
        throw new AuthenticationError(i18n.t('errors.auth.redirectLocation'));
      }
      if (redirects++ === MAX_REDIRECTS) {
        throw new AuthenticationError(
          i18n.t('errors.download.tooManyRedirects'),
        );
      }
      endpoint = authEndpoint(response.headers.location, endpoint);
      continue;
    }

    if (!response.body.trim()) {
      throw new AuthenticationError(
        i18n.t('errors.auth.emptyBody', { status: response.status }),
      );
    }
    const dict = responseDictionary(response.body);
    if (!dict) {
      throw new AuthenticationError(
        `Apple authentication: HTTP ${response.status}, invalid plist response`,
      );
    }
    if (String(dict.failureType) === '-5000' && attempt === 1) {
      attempt = 2;
      plistBody = serialize();
      bodyBytes = new TextEncoder().encode(plistBody);
      continue;
    }
    if (
      !dict.failureType &&
      dict.customerMessage === 'MZFinance.BadLogin.Configurator_message'
    ) {
      throw new AuthenticationError(
        i18n.t(
          code
            ? 'errors.auth.invalidVerificationCode'
            : 'errors.auth.requiresVerification',
        ),
        true,
      );
    }
    const failureMessage = dict.dialog?.explanation ?? dict.customerMessage;
    if (String(dict.failureType) === '5005') {
      throw new AuthenticationError(
        failureMessage || i18n.t('errors.auth.invalidVerificationCode'),
        true,
      );
    }
    if (
      response.status !== 200 ||
      dict.failureType ||
      !dict.passwordToken ||
      !dict.dsPersonId
    ) {
      throw new AuthenticationError(
        failureMessage || i18n.t('errors.auth.unknownReason'),
      );
    }
    const accountInfo = dict.accountInfo;
    if (!accountInfo) {
      throw new AuthenticationError(i18n.t('errors.auth.missingAccountInfo'));
    }
    if (!accountInfo.address) {
      throw new AuthenticationError(i18n.t('errors.auth.missingAddress'));
    }
    return {
      email,
      password,
      appleId: accountInfo.appleId ?? '',
      store: storeFront,
      firstName: accountInfo.address.firstName ?? '',
      lastName: accountInfo.address.lastName ?? '',
      passwordToken: dict.passwordToken,
      directoryServicesIdentifier: String(dict.dsPersonId),
      cookies,
      deviceIdentifier: deviceId,
      pod,
    };
  }
}
