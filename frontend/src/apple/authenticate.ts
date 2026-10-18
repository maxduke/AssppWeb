import { authEndpoint, fetchBag } from './bag';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest } from './request';
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
  onRetry?: (retry: AuthRetry) => void,
) {
  const statuses: number[] = [];
  for (;;) {
    const response = await send();
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
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId = '',
  onRetry?: (retry: AuthRetry) => void,
): Promise<Account> {
  let cookies = [...(existingCookies ?? [])];
  let storeFront = '';
  let pod: string | undefined;
  const bag = await fetchBag(deviceId);
  if (!bag.sapEndpoints) {
    throw new AuthenticationError(i18n.t('errors.auth.missingSigningConfig'));
  }
  let endpoint = authEndpoint(bag.authURL);
  endpoint.searchParams.set('guid', deviceId);
  const { signWithSap } = await import('./sap/client');
  // Reuse these exact bytes for both signing and every redirected/retried POST.
  const plistBody = buildPlist({
    appleId: email,
    attempt: code ? '2' : '4',
    guid: deviceId,
    password: code ? `${password}${code}` : password,
    rmp: '0',
    why: 'signIn',
  });
  const bodyBytes = new TextEncoder().encode(plistBody);
  let credentialRetry = false;
  let redirects = 0;

  for (;;) {
    const response = await sendWithTransientRetry(async () => {
      const signature = await signWithSap(
        deviceId,
        bag.sapEndpoints!,
        bodyBytes,
      );
      const sent = await appleRequest({
        method: 'POST',
        host: endpoint.hostname,
        path: endpoint.pathname + endpoint.search,
        headers: {
          'Content-Type': 'application/x-apple-plist',
          'X-Apple-ActionSignature': signature,
        },
        body: plistBody,
        cookies,
      });
      cookies = extractAndMergeCookies(sent.rawHeaders, cookies);
      return sent;
    }, onRetry);

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
    let dict: Record<string, any>;
    try {
      dict = parsePlist(response.body);
      if (!dict || typeof dict !== 'object' || Array.isArray(dict))
        throw new Error();
    } catch {
      throw new AuthenticationError(
        `Apple authentication: HTTP ${response.status}, invalid plist response`,
      );
    }
    if (String(dict.failureType) === '-5000' && !credentialRetry) {
      credentialRetry = true;
      continue;
    }
    if (
      !dict.failureType &&
      !code &&
      dict.customerMessage === 'MZFinance.BadLogin.Configurator_message'
    ) {
      throw new AuthenticationError(
        i18n.t('errors.auth.requiresVerification'),
        true,
      );
    }
    const failureMessage = dict.dialog?.explanation ?? dict.customerMessage;
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
