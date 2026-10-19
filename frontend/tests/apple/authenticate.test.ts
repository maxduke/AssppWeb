import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist } from '../../src/apple/plist';
import { authenticate } from '../../src/apple/authenticate';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';

vi.mock('../../src/apple/sap/client', () => ({
  signWithSap: vi.fn().mockResolvedValue('test-signature'),
}));

const sapEndpoints = {
  certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
  setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
  version: 200,
};

vi.mock('../../src/apple/request', () => ({
  appleRequest: vi.fn(),
}));

vi.mock('../../src/apple/bag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apple/bag')>()),
  fetchBag: vi.fn(),
  defaultAuthURL:
    'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
}));

describe('apple/authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets guid query exactly once from bag endpoint', async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      sapEndpoints,
      authURL:
        'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value',
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: 'test@example.com',
          address: {
            firstName: 'Test',
            lastName: 'User',
          },
        },
        passwordToken: 'token',
        dsPersonId: '123',
      }),
    });

    await authenticate(
      'test@example.com',
      'password',
      undefined,
      undefined,
      'aabbccddeeff',
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.pathname).toBe(
      '/WebObjects/MZFinance.woa/wa/authenticate/',
    );
    expect(endpoint.searchParams.get('guid')).toBe('aabbccddeeff');
    expect(endpoint.searchParams.getAll('guid')).toHaveLength(1);
    expect(endpoint.searchParams.get('foo')).toBe('1');
  });
  it.each([301, 302, 303, 307, 308])(
    'normalizes a relative legacy redirect (%s) and preserves its query',
    async (status) => {
      vi.mocked(fetchBag).mockResolvedValue({
        sapEndpoints,
        authURL:
          'https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      });
      vi.mocked(appleRequest)
        .mockResolvedValueOnce({
          status,
          statusText: 'Redirect',
          headers: {
            location:
              '/WebObjects/MZFinance.woa/wa/authenticate?routing=a%2Fb&guid=aabbccddeeff',
          },
          rawHeaders: [],
          body: '',
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: {},
          rawHeaders: [],
          body: buildPlist({
            accountInfo: {
              appleId: 'test@example.com',
              address: { firstName: 'Test', lastName: 'User' },
            },
            passwordToken: 'token',
            dsPersonId: '123',
          }),
        });

      await authenticate(
        'test@example.com',
        'password',
        undefined,
        undefined,
        'aabbccddeeff',
      );

      expect(appleRequest).toHaveBeenCalledTimes(2);
      expect(vi.mocked(appleRequest).mock.calls[1][0]).toMatchObject({
        host: 'p25-buy.itunes.apple.com',
        path: '/WebObjects/MZFinance.woa/wa/authenticate/?routing=a%2Fb&guid=aabbccddeeff',
      });
    },
  );
});

it('fails closed when the bag has no signing configuration', async () => {
  vi.mocked(appleRequest).mockClear();
  vi.mocked(fetchBag).mockResolvedValue({
    authURL:
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/',
  });
  await expect(
    authenticate('test@example.invalid', 'private-password'),
  ).rejects.toThrow();
  expect(appleRequest).not.toHaveBeenCalled();
});

it.each([
  'http://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
  'https://evil.invalid/WebObjects/MZFinance.woa/wa/authenticate',
  'https://user:pass@buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
  'https://buy.itunes.apple.com:444/WebObjects/MZFinance.woa/wa/authenticate',
  'https://buy.itunes.apple.com/other',
])('rejects a credential redirect to %s', async (location) => {
  vi.mocked(appleRequest).mockReset().mockResolvedValue({
    status: 302,
    statusText: '',
    headers: { location },
    rawHeaders: [],
    body: '',
  });
  vi.mocked(fetchBag).mockResolvedValue({
    authURL:
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
    sapEndpoints,
  });
  await expect(
    authenticate(
      'test@example.invalid',
      'private-password',
      undefined,
      undefined,
      'aabbccddeeff',
    ),
  ).rejects.toThrow('endpoint');
  expect(appleRequest).toHaveBeenCalledTimes(1);
});

it('signs exactly the UTF-8 bytes sent, retaining the body and cookies across redirects', async () => {
  const { signWithSap } = await import('../../src/apple/sap/client');
  vi.mocked(signWithSap).mockClear();
  vi.mocked(fetchBag).mockResolvedValue({
    authURL:
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
    sapEndpoints,
  });
  vi.mocked(appleRequest)
    .mockReset()
    .mockResolvedValueOnce({
      status: 307,
      statusText: '',
      headers: {
        location:
          'https://p26-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      },
      rawHeaders: [
        [
          'set-cookie',
          'session=continued; Domain=.itunes.apple.com; Path=/; Secure',
        ],
      ],
      body: '',
    })
    .mockResolvedValueOnce({
      status: 200,
      statusText: '',
      headers: { pod: '26' },
      rawHeaders: [],
      body: buildPlist({
        accountInfo: { address: {} },
        passwordToken: 'token',
        dsPersonId: '123',
      }),
    });
  await authenticate(
    'test@example.invalid',
    '密码&<>',
    '123456',
    undefined,
    'aabbccddeeff',
  );
  const [first, second] = vi
    .mocked(appleRequest)
    .mock.calls.map(([request]) => request);
  expect(first.body).toBe(second.body);
  expect(second.cookies).toEqual(
    expect.arrayContaining([expect.objectContaining({ value: 'continued' })]),
  );
  for (const [index, [request]] of vi
    .mocked(appleRequest)
    .mock.calls.entries()) {
    expect(request.headers?.['X-Apple-ActionSignature']).toBe('test-signature');
    expect(signWithSap).toHaveBeenNthCalledWith(
      index + 1,
      'aabbccddeeff',
      sapEndpoints,
      new TextEncoder().encode(request.body),
      expect.any(AbortSignal),
    );
  }
});

it('rejects an incomplete success response without sending credentials again', async () => {
  vi.mocked(fetchBag).mockResolvedValue({
    authURL:
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
    sapEndpoints,
  });
  vi.mocked(appleRequest)
    .mockReset()
    .mockResolvedValue({
      status: 200,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: buildPlist({ accountInfo: { address: {} } }),
    });
  await expect(
    authenticate(
      'test@example.invalid',
      'private-password',
      undefined,
      undefined,
      'aabbccddeeff',
    ),
  ).rejects.toThrow();
  expect(appleRequest).toHaveBeenCalledOnce();
});
