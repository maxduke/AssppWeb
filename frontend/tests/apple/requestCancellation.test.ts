import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLibcurl, libcurl } from '../../src/apple/libcurl-init';
import { appleRequest } from '../../src/apple/request';

vi.mock('../../src/apple/libcurl-init', () => ({
  initLibcurl: vi.fn(),
  libcurl: { fetch: vi.fn() },
}));

const request = (signal: AbortSignal) =>
  appleRequest({
    host: 'buy.itunes.apple.com',
    path: '/WebObjects/MZFinance.woa/wa/authenticate',
    method: 'POST',
    body: 'test-credentials',
    signal,
  });

beforeEach(() => {
  vi.mocked(initLibcurl).mockReset().mockResolvedValue();
  vi.mocked(libcurl.fetch).mockReset();
});

describe('Apple request cancellation', () => {
  it('does not initialize or send when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(request(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(initLibcurl).not.toHaveBeenCalled();
    expect(libcurl.fetch).not.toHaveBeenCalled();
  });

  it('does not send credentials after cancelled initialization completes late', async () => {
    let complete!: () => void;
    vi.mocked(initLibcurl).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const assertion = expect(request(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(initLibcurl).toHaveBeenCalledOnce();
    controller.abort();
    await assertion;
    complete();
    await Promise.resolve();
    expect(libcurl.fetch).not.toHaveBeenCalled();
  });

  it('rejects while the response body is stalled and ignores late completion', async () => {
    let complete!: (body: string) => void;
    const text = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(libcurl.fetch).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      raw_headers: [],
      text,
    } as unknown as Awaited<ReturnType<typeof libcurl.fetch>>);
    const controller = new AbortController();
    const assertion = expect(request(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    complete('late-account-response');
    await Promise.resolve();
    expect(libcurl.fetch).toHaveBeenCalledOnce();
    expect(libcurl.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
        redirect: 'manual',
      }),
    );
  });
});
