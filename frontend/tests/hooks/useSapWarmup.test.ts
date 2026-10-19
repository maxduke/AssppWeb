import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSapWarmup } from '../../src/hooks/useSapWarmup';
import { useAccountsStore } from '../../src/store/accounts';
import { useSapStore } from '../../src/store/sap';
import { fetchBag } from '../../src/apple/bag';
import { prepareSigner } from '../../src/apple/sap/client';

vi.mock('../../src/store/accounts', async () => {
  const { create } = await import('zustand');
  return {
    useAccountsStore: create(() => ({
      accounts: [{ deviceIdentifier: 'aabbccddeeff' }],
    })),
  };
});
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
vi.mock('../../src/apple/sap/client', () => ({ prepareSigner: vi.fn() }));

const bag = {
  authURL:
    'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
  sapEndpoints: {
    certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
    setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
    version: 200,
  },
};

beforeEach(() => {
  vi.mocked(fetchBag).mockReset().mockResolvedValue(bag);
  vi.mocked(prepareSigner).mockReset();
  useSapStore.getState().reset();
});
afterEach(() => cleanup());

describe('SAP warmup lifecycle', () => {
  it('does not cancel its preparation as progress or the accounts array changes', async () => {
    let complete!: () => void;
    vi.mocked(prepareSigner).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    renderHook(() => useSapWarmup());
    await waitFor(() => expect(prepareSigner).toHaveBeenCalledOnce());
    const signal = vi.mocked(prepareSigner).mock.calls[0][2]!;
    act(() => {
      useSapStore.getState().begin('aabbccddeeff');
      useSapStore.getState().setAssets(50);
      useSapStore.getState().setSetup();
      useAccountsStore.setState({
        accounts: [...useAccountsStore.getState().accounts],
      });
    });
    expect(signal.aborted).toBe(false);
    expect(fetchBag).toHaveBeenCalledOnce();
    expect(prepareSigner).toHaveBeenCalledOnce();
    await act(async () => complete());
  });

  it('aborts active preparation when the owner unmounts', async () => {
    vi.mocked(prepareSigner).mockImplementation(
      (...args) =>
        new Promise<void>((_resolve, reject) => {
          args[2]!.addEventListener('abort', () => reject(args[2]!.reason), {
            once: true,
          });
        }),
    );
    const view = renderHook(() => useSapWarmup());
    await waitFor(() => expect(prepareSigner).toHaveBeenCalledOnce());
    const signal = vi.mocked(prepareSigner).mock.calls[0][2]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('does not prepare after a cancelled bag lookup resolves late', async () => {
    let complete!: (value: typeof bag) => void;
    vi.mocked(fetchBag).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = renderHook(() => useSapWarmup());
    const signal = vi.mocked(fetchBag).mock.calls[0][1]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => complete(bag));
    expect(prepareSigner).not.toHaveBeenCalled();
  });
});
