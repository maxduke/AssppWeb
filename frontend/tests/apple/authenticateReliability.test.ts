import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../../src/apple/authenticate';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import { signWithSap } from '../../src/apple/sap/client';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/sap/client', () => ({
  signWithSap: vi.fn().mockResolvedValue('test-signature'),
}));
vi.mock('../../src/apple/bag', async (original) => ({
  ...(await original<typeof import('../../src/apple/bag')>()),
  fetchBag: vi.fn(),
}));

const bag = {
  authURL:
    'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/',
  sapEndpoints: {
    certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
    setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
    version: 200,
  },
};
const reply = (status: number, data: Record<string, unknown>) => ({
  status,
  statusText: '',
  headers: {},
  rawHeaders: [] as [string, string][],
  body: buildPlist(data),
});
const success = () =>
  reply(200, {
    accountInfo: { address: {} },
    passwordToken: 'test-token',
    dsPersonId: '123',
  });
const login = (code?: string, signal?: AbortSignal, onRetry = vi.fn()) =>
  authenticate(
    'test@example.invalid',
    'test-password',
    code,
    undefined,
    'aabbccddeeff',
    onRetry,
    signal,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(appleRequest).mockReset();
  vi.mocked(signWithSap).mockResolvedValue('test-signature');
  vi.mocked(fetchBag).mockResolvedValue(bag);
});
afterEach(() => vi.useRealTimers());

describe('credential retries', () => {
  it.each([undefined, '123456'])(
    'advances only the credential attempt, including with 2FA %s',
    async (code) => {
      vi.mocked(appleRequest)
        .mockResolvedValueOnce(reply(200, { failureType: '-5000' }))
        .mockResolvedValueOnce(success());
      await login(code);
      const requests = vi
        .mocked(appleRequest)
        .mock.calls.map(([request]) => request);
      expect(
        requests.map((request) => parsePlist(request.body!).attempt),
      ).toEqual(['1', '2']);
      expect(requests[0].body).not.toBe(requests[1].body);
      for (const [index, request] of requests.entries()) {
        expect(parsePlist(request.body!)).toMatchObject({
          guid: 'aabbccddeeff',
          password: `test-password${code ?? ''}`,
        });
        expect(signWithSap.mock.calls[index][2]).toEqual(
          new TextEncoder().encode(request.body),
        );
      }
    },
  );

  it('does not retry a second explicit credential failure', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      reply(200, {
        failureType: '-5000',
        customerMessage: 'Incorrect credentials',
      }),
    );
    await expect(login()).rejects.toThrow('Incorrect credentials');
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('keeps bytes and cookies across transport retries and redirects, then advances on -5000', async () => {
    vi.useFakeTimers();
    const transient = {
      ...success(),
      status: 503,
      body: '',
      rawHeaders: [
        [
          'set-cookie',
          'session=retry-cookie; Domain=.itunes.apple.com; Path=/; Secure',
        ],
      ] as [string, string][],
    };
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce({
        ...success(),
        status: 302,
        body: '',
        headers: {
          location:
            'https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
        },
      })
      .mockResolvedValueOnce(reply(503, { failureType: '-5000' }))
      .mockResolvedValueOnce(success());
    vi.mocked(signWithSap).mockImplementation(
      async () => `signature-${signWithSap.mock.calls.length}`,
    );
    const pending = login();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    const requests = vi.mocked(appleRequest).mock.calls.map(([value]) => value);
    expect(requests.map((value) => parsePlist(value.body!).attempt)).toEqual([
      '1',
      '1',
      '1',
      '2',
    ]);
    expect(signWithSap).toHaveBeenCalledTimes(4);
    const signedBytes = vi
      .mocked(signWithSap)
      .mock.calls.map((call) => call[2]);
    expect(signedBytes[0]).toBe(signedBytes[1]);
    expect(signedBytes[1]).toBe(signedBytes[2]);
    expect(signedBytes[2]).not.toBe(signedBytes[3]);
    for (const [index, sent] of requests.entries()) {
      expect(signedBytes[index]).toEqual(new TextEncoder().encode(sent.body));
      expect(sent.headers?.['X-Apple-ActionSignature']).toBe(
        `signature-${index + 1}`,
      );
      if (index > 0)
        expect(sent.cookies).toEqual([
          expect.objectContaining({ name: 'session', value: 'retry-cookie' }),
        ]);
    }
    expect(requests[2].host).toBe('p25-buy.itunes.apple.com');
    expect(requests[3].host).toBe('p25-buy.itunes.apple.com');
  });
});

describe('structured Apple responses', () => {
  it.each([429, 503])(
    'preserves a business error on HTTP %s without transport retries',
    async (status) => {
      vi.useFakeTimers();
      const onRetry = vi.fn();
      vi.mocked(appleRequest).mockResolvedValue({
        ...reply(status, {
          failureType: '5005',
          customerMessage: 'Incorrect verification code',
        }),
        headers: { 'retry-after': '120' },
      });
      const assertion = expect(
        login(undefined, undefined, onRetry),
      ).rejects.toThrow('Incorrect verification code');
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(appleRequest).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    },
  );

  it('preserves the need for verification even when Apple uses HTTP 503', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest).mockResolvedValue(
      reply(503, {
        customerMessage: 'MZFinance.BadLogin.Configurator_message',
      }),
    );
    const assertion = expect(login()).rejects.toMatchObject({
      codeRequired: true,
    });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });
});

describe('authentication cancellation and deadline', () => {
  it('does no work for a caller that already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(appleRequest).mockResolvedValue(success());
    await expect(login(undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchBag).not.toHaveBeenCalled();
    expect(signWithSap).not.toHaveBeenCalled();
    expect(appleRequest).not.toHaveBeenCalled();
  });

  it('ignores a late bag response after cancellation', async () => {
    let complete!: (value: typeof bag) => void;
    vi.mocked(fetchBag).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(appleRequest).mockResolvedValue(success());
    const controller = new AbortController();
    const assertion = expect(
      login(undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.dynamicImportSettled();
    controller.abort();
    complete(bag);
    await assertion;
    expect(appleRequest).not.toHaveBeenCalled();
  });

  it('cancels retry backoff without sending another credential request', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest).mockResolvedValue({
      ...success(),
      status: 503,
      body: '',
    });
    const controller = new AbortController();
    const assertion = expect(
      login(undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.dynamicImportSettled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole operation, including a stalled bag fetch', async () => {
    vi.useFakeTimers();
    let complete!: (value: typeof bag) => void;
    vi.mocked(fetchBag).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(appleRequest).mockResolvedValue(success());
    const assertion = expect(login()).rejects.toThrow(/timed out|超时/);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    complete(bag);
    await assertion;
    expect(appleRequest).not.toHaveBeenCalled();
  });
});
