// Caller-level regressions adapted from upstream #92, using #90's stricter protocol.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
const account = {
  email: 'test@example.invalid',
  store: '143465',
  cookies: [],
  deviceIdentifier: 'aabbccddeeff',
  directoryServicesIdentifier: '123',
  pod: '26',
} as unknown as Account;
const app = { id: 736536022, bundleID: 'tv.danmaku.bilianime' } as Software;
const metadata = {
  itemId: app.id,
  softwareVersionExternalIdentifier: 891730218,
  softwareVersionBundleId: app.bundleID,
  bundleShortVersionString: '9.13.0',
  bundleVersion: '913000',
  softwareVersionExternalIdentifiers: [100, 891730218],
  releaseDate: '2026-10-01',
  passwordToken: 'must-not-leave-browser',
};
function reply(dict: Record<string, unknown>, status = 200) {
  return {
    status,
    statusText: '',
    headers: {},
    rawHeaders: [] as [string, string][],
    body: buildPlist(dict),
  };
}
function success(
  overrides: Record<string, unknown> = {},
  url = 'https://example.apple.com/app.ipa',
) {
  return reply({
    songList: [
      {
        URL: url,
        metadata: { ...metadata, ...overrides },
        sinfs: [{ id: 0, sinf: 'AA==' }],
      },
    ],
  });
}
function catalog() {
  return {
    ...reply({}),
    body: JSON.stringify({
      results: {
        [app.id]: {
          id: app.id,
          kind: 'iosSoftware',
          bundleId: app.bundleID,
          offers: [
            {
              assets: [{ flavor: 'tvosSoftware' }],
              version: { externalId: 9 },
            },
            {
              assets: [{ flavor: 'iosSoftware' }],
              version: { externalId: 891730218 },
            },
          ],
        },
      },
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchBag).mockResolvedValue({
    authURL: '',
    updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
  });
});

describe('download and version callers', () => {
  it.each(['download', 'versions', 'metadata'])(
    'recovers empty 500 for %s, preserving cookies and version',
    async (operation) => {
      vi.mocked(appleRequest).mockResolvedValueOnce(reply({ songList: [] }));
      if (operation !== 'metadata')
        vi.mocked(appleRequest).mockResolvedValueOnce(catalog());
      vi.mocked(appleRequest)
        .mockResolvedValueOnce({
          ...reply({}, 500),
          body: '',
          rawHeaders: [
            [
              'set-cookie',
              'storeSession=continued; Domain=.itunes.apple.com; Path=/; Secure',
            ],
          ],
        })
        .mockResolvedValueOnce(success());
      if (operation === 'download') {
        const result = await getDownloadInfo(account, app);
        const data = Uint8Array.from(atob(result.output.iTunesMetadata!), (c) =>
          c.charCodeAt(0),
        );
        expect(parsePlist(new TextDecoder().decode(data))).not.toHaveProperty(
          'passwordToken',
        );
      } else if (operation === 'versions') {
        expect((await listVersions(account, app)).versions).toEqual([
          '891730218',
          '100',
        ]);
      } else {
        expect(
          (await getVersionMetadata(account, app, '891730218')).metadata
            .displayVersion,
        ).toBe('9.13.0');
      }
      const requests = vi
        .mocked(appleRequest)
        .mock.calls.map(([request]) => request);
      const last = requests.at(-1)!;
      expect(last.path).toBe('/up/updateProduct?guid=aabbccddeeff');
      expect(parsePlist(last.body!)).toMatchObject({
        appExtVrsId: '891730218',
      });
      expect(last.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'continued' }),
        ]),
      );
      for (const request of requests.filter((r) => r.method === 'GET')) {
        expect(request.path).toContain('cc=cn');
        expect(request.cookies).toBeUndefined();
        expect(request.headers).toBeUndefined();
      }
    },
  );

  it('retains the historical ID across all three endpoints without consulting the catalog', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(reply({ songList: [] }))
      .mockResolvedValueOnce(
        reply({ customerMessage: 'This item is no longer available' }),
      )
      .mockResolvedValueOnce(
        success({ softwareVersionExternalIdentifier: 100 }),
      );
    await getDownloadInfo(account, app, '100');
    const requests = vi
      .mocked(appleRequest)
      .mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    expect(parsePlist(requests[0].body!)).toHaveProperty(
      'externalVersionId',
      '100',
    );
    for (const request of requests.slice(1))
      expect(parsePlist(request.body!)).toHaveProperty('appExtVrsId', '100');
  });

  it.each([
    {},
    { songList: {} },
    { failureType: '2034' },
    { failureType: '9610' },
    { customerMessage: 'Your password has changed.' },
  ])(
    'does not recover malformed or actionable primary responses: %j',
    async (dict) => {
      vi.mocked(appleRequest).mockResolvedValue(reply(dict));
      await expect(getDownloadInfo(account, app)).rejects.toThrow();
      expect(appleRequest).toHaveBeenCalledOnce();
      expect(fetchBag).not.toHaveBeenCalled();
    },
  );

  it.each([
    { itemId: 1 },
    { softwareVersionExternalIdentifier: 1 },
    { softwareVersionBundleId: 'wrong.app' },
  ])(
    'rejects mismatched primary success as well as fallback success: %j',
    async (wrong) => {
      vi.mocked(appleRequest).mockResolvedValue(success(wrong));
      await expect(getDownloadInfo(account, app, '891730218')).rejects.toThrow(
        'does not match',
      );
      expect(appleRequest).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'http://example.apple.com/app.ipa',
    'https://apple.com.evil.invalid/app.ipa',
    'https://user:pass@example.apple.com/app.ipa',
  ])('rejects an invalid download URL %s', async (url) => {
    vi.mocked(appleRequest).mockResolvedValue(success({}, url));
    await expect(getDownloadInfo(account, app)).rejects.toThrow('download URL');
  });

  it.each([403, 429, 500])(
    'keeps nonempty HTTP %s failures and redacts body/query',
    async (status) => {
      vi.mocked(appleRequest)
        .mockResolvedValueOnce(reply({ songList: [] }))
        .mockResolvedValue({
          ...reply({}, status),
          body: '<html>private-token aabbccddeeff</html>',
        });
      const result = getDownloadInfo(account, app, '100');
      await expect(result).rejects.toThrow(`HTTP ${status}`);
      await expect(result).rejects.not.toThrow(
        /private-token|aabbccddeeff|guid=/,
      );
      expect(appleRequest).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects an unsafe redirect before sending DSID or cookies to it', async () => {
    vi.mocked(appleRequest).mockResolvedValue({
      ...reply({}, 302),
      headers: { location: 'https://evil.invalid/?token=secret' },
    });
    await expect(getDownloadInfo(account, app)).rejects.toThrow('Unsafe');
    expect(appleRequest).toHaveBeenCalledOnce();
  });
});
