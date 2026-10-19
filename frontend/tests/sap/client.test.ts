import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticationTimeoutMs } from '../../src/apple/config';
import type { SapAssetBundle } from '../../src/apple/sap/types';

vi.mock('../../src/apple/sap/assets', () => ({
  loadSapAssets: vi.fn(async () => ({
    commerceKit: new Uint8Array(1),
    commerceCore: new Uint8Array(1),
    coreFP: new Uint8Array(1),
    coreFPICXS: new Uint8Array(1),
  })),
}));
vi.mock('../../src/apple/sap/protocol', () => ({
  fetchSetupCertificate: vi.fn(async () => new Uint8Array([1])),
  exchangeSetupBuffer: vi.fn(async () => new Uint8Array([2])),
}));
const endpoints = {
  version: 200,
  certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
  setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
};
const workers: FakeWorker[] = [];
let hold: string | null = null;

class FakeWorker {
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  hardware = '';
  exchanges = 0;
  requests: string[] = [];
  release: (() => void) | null = null;
  constructor() {
    workers.push(this);
  }
  postMessage(request: any) {
    this.requests.push(request.type);
    if (request.type === 'initialize')
      this.hardware = new TextDecoder().decode(request.hardwareID);
    const respond = () =>
      this.onmessage?.({
        data: {
          type: 'result',
          id: request.id,
          contextValue: 1,
          state: request.type === 'exchange' && this.exchanges++ === 0 ? 1 : 0,
          output: new Uint8Array([1]).buffer,
          signature: new TextEncoder().encode(this.hardware).buffer,
        },
      });
    if (request.type === hold) this.release = respond;
    else queueMicrotask(respond);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  workers.length = 0;
  hold = null;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

describe('SAP worker lifecycle', () => {
  it('bounds a stalled asset preparation and permits the next account to retry', async () => {
    const { prepareSigner, signWithSap } = await import(
      '../../src/apple/sap/client'
    );
    const { loadSapAssets: load } = await import('../../src/apple/sap/assets');
    vi.useFakeTimers();
    vi.mocked(load).mockImplementationOnce(() => new Promise(() => {}));
    const pending = prepareSigner('account-a', endpoints);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(authenticationTimeoutMs);
    await rejected;
    expect(workers).toHaveLength(0);
    await expect(
      signWithSap('account-b', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-b'));
    expect(workers).toHaveLength(1);
  });

  it('cancels stalled assets without publishing a late preparation or progress update', async () => {
    const { prepareSigner, signWithSap } = await import(
      '../../src/apple/sap/client'
    );
    const { loadSapAssets: load } = await import('../../src/apple/sap/assets');
    const { useSapStore } = await import('../../src/store/sap');
    let complete!: (value: SapAssetBundle) => void;
    vi.mocked(load).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const rejected = expect(
      prepareSigner('account-a', endpoints, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => !!complete);
    const oldProgress = vi.mocked(load).mock.calls[0][0];
    controller.abort();
    await rejected;
    await expect(
      signWithSap('account-b', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-b'));
    complete({
      commerceKit: new Uint8Array(1),
      commerceCore: new Uint8Array(1),
      coreFP: new Uint8Array(1),
      coreFPICXS: new Uint8Array(1),
    });
    oldProgress?.(1, 1);
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    expect(useSapStore.getState()).toMatchObject({
      stage: 'ready',
      hardwareID: 'account-b',
    });
  });

  it('cancelling a queued account does not terminate the active signature', async () => {
    const { signWithSap } = await import('../../src/apple/sap/client');
    hold = 'sign';
    const active = signWithSap('account-a', endpoints, new Uint8Array(1));
    await until(() => !!workers[0]?.release);
    const controller = new AbortController();
    const cancelled = expect(
      signWithSap('account-b', endpoints, new Uint8Array(1), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    expect(workers[0].terminate).not.toHaveBeenCalled();
    hold = null;
    workers[0].release!();
    expect(await active).toBe(btoa('account-a'));
    await expect(
      signWithSap('account-a', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-a'));
    expect(workers).toHaveLength(1);
  });

  it('terminates a cancelled active worker and prepares a fresh signer', async () => {
    const { signWithSap } = await import('../../src/apple/sap/client');
    const controller = new AbortController();
    hold = 'sign';
    const cancelled = expect(
      signWithSap('account-a', endpoints, new Uint8Array(1), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => !!workers[0]?.release);
    controller.abort();
    await cancelled;
    hold = null;
    await expect(
      signWithSap('account-b', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-b'));
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    workers[0].release!();
    await expect(
      signWithSap('account-b', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-b'));
    expect(workers).toHaveLength(2);
  });

  it('cancels a stalled WASM download before creating a worker', async () => {
    const { prepareSigner, signWithSap } = await import(
      '../../src/apple/sap/client'
    );
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const cancelled = expect(
      prepareSigner('account-a', endpoints, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => vi.mocked(fetch).mock.calls.length === 1);
    controller.abort();
    await cancelled;
    expect(workers).toHaveLength(0);
    await expect(
      signWithSap('account-b', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-b'));
  });

  it('shares a prepared worker for concurrent calls on one account', async () => {
    const { prepareSigner, signWithSap } = await import(
      '../../src/apple/sap/client'
    );
    await Promise.all([
      prepareSigner('account-a', endpoints),
      prepareSigner('account-a', endpoints),
    ]);
    const results = await Promise.all([
      signWithSap('account-a', endpoints, new Uint8Array(1)),
      signWithSap('account-a', endpoints, new Uint8Array(1)),
    ]);
    expect(results).toEqual([btoa('account-a'), btoa('account-a')]);
    expect(workers).toHaveLength(1);
    expect(
      workers[0].requests.filter((type) => type === 'initialize'),
    ).toHaveLength(1);
  });

  it('does not switch accounts or terminate a worker during a signature', async () => {
    const { signWithSap } = await import('../../src/apple/sap/client');
    hold = 'sign';
    const first = signWithSap('account-a', endpoints, new Uint8Array(1));
    await until(() => !!workers[0]?.release);
    const second = signWithSap('account-b', endpoints, new Uint8Array(1));
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    hold = null;
    workers[0].release!();
    expect(await first).toBe(btoa('account-a'));
    expect(await second).toBe(btoa('account-b'));
    expect(workers).toHaveLength(2);
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it('rejects worker crashes, terminates the worker and permits a fresh preparation', async () => {
    const { signWithSap } = await import('../../src/apple/sap/client');
    hold = 'open';
    const first = signWithSap('account-a', endpoints, new Uint8Array(1));
    const rejected = expect(first).rejects.toThrow('worker failed');
    await until(() => !!workers[0]?.release);
    workers[0].onerror!({ preventDefault() {} });
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalled();
    hold = null;
    await expect(
      signWithSap('account-a', endpoints, new Uint8Array(1)),
    ).resolves.toBe(btoa('account-a'));
    expect(workers).toHaveLength(2);
  });

  it('bounds a hung worker and rejects invalid setup URLs before loading assets', async () => {
    const { signWithSap } = await import('../../src/apple/sap/client');
    await expect(
      signWithSap(
        'account-a',
        { ...endpoints, setupURL: 'https://evil.invalid/' },
        new Uint8Array(1),
      ),
    ).rejects.toThrow('endpoint');
    expect(workers).toHaveLength(0);
    hold = 'open';
    const pending = signWithSap('account-a', endpoints, new Uint8Array(1));
    const rejected = expect(pending).rejects.toThrow('timed out');
    await until(() => !!workers[0]?.release);
    vi.useFakeTimers();
    // Existing timers were scheduled with real timers; switch before the next request instead.
    workers[0].release!();
    hold = 'initialize';
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalled();
  });
});

it('replaces a worker that crashed while idle before the next signature', async () => {
  const { prepareSigner, signWithSap } = await import(
    '../../src/apple/sap/client'
  );
  await prepareSigner('account-a', endpoints);
  workers[0].onerror!({ preventDefault() {} });
  await expect(
    signWithSap('account-a', endpoints, new Uint8Array(1)),
  ).resolves.toBe(btoa('account-a'));
  expect(workers).toHaveLength(2);
});
