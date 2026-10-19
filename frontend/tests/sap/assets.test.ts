import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSapAssets, SAP_ASSET_SPECS } from '../../src/apple/sap/assets';

const cache = { match: vi.fn(), put: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  cache.match.mockResolvedValue(undefined);
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('SAP asset cancellation', () => {
  it('cancels a stalled stream without waiting for its cancel handler', async () => {
    const reader = {
      read: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(() => new Promise(() => {})),
      releaseLock: vi.fn(),
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response);
    const controller = new AbortController();
    const rejected = expect(
      loadSapAssets(undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each(['open', 'match', 'body'])(
    'does not fall back to a download after cancelling a stalled cache %s',
    async (stage) => {
      if (stage === 'open')
        vi.mocked(caches.open).mockImplementation(() => new Promise(() => {}));
      if (stage === 'match')
        cache.match.mockImplementation(() => new Promise(() => {}));
      if (stage === 'body')
        cache.match.mockResolvedValue({
          arrayBuffer: () => new Promise(() => {}),
        });
      const controller = new AbortController();
      const rejected = expect(
        loadSapAssets(undefined, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('keeps the pinned decoded-size bound and closes an oversized stream', async () => {
    const reader = {
      read: vi
        .fn()
        .mockResolvedValue({
          done: false,
          value: new Uint8Array(SAP_ASSET_SPECS[0].size + 1),
        }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response);
    await expect(loadSapAssets()).rejects.toThrow('exceeds expected size');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
