// Main-thread SAP signer manager.
//
// The signer is kept as a module-level singleton bound to the hardware id it
// was initialized with: creating the worker copies the ~22.5 MB asset bundle
// into it, and repeating that per sign-in (2FA retries included) is pure
// waste. `prepareSigner` reuses a matching signer or rebuilds for a different
// account; concurrent callers share the same preparation. The zustand store
// in store/sap.ts carries progress for the UI.

import { useSapStore } from '../../store/sap';
import { SapSigner } from './signer';
import { validateSapSignerOptions } from './types';
import { exchangeSetupBuffer, fetchSetupCertificate } from './protocol';
import { loadSapAssets } from './assets';
import {
  abortable,
  createDeadline,
  isAbortError,
  throwIfAborted,
} from '../../utils/abort';
import { authenticationTimeoutMs } from '../config';
import i18n from '../../i18n';
import type { SapMachineDriver } from './signer';
import type { SapEndpoints } from './types';

interface WorkerResult {
  type: 'result';
  id: number;
  [key: string]: unknown;
}

interface WorkerError {
  type: 'error';
  id: number;
  message: string;
}

const SETUP_TIMEOUT_MS = 2 * 60 * 1000;

class WorkerMachineDriver implements SapMachineDriver {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: WorkerResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private closed = false;

  get active(): boolean {
    return !this.closed;
  }

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerResult | WorkerError>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.type === 'error') {
        entry.reject(new Error(message.message));
      } else {
        entry.resolve(message);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.abort(new Error('SAP signing worker failed'));
    };
    worker.onmessageerror = () =>
      this.abort(new Error('Invalid SAP worker response'));
  }

  private abort(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  call(request: Record<string, unknown>): Promise<WorkerResult> {
    const id = this.nextId++;
    if (this.closed) return Promise.reject(new Error('SAP worker is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.abort(new Error('SAP worker timed out')),
        SETUP_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...request, id });
      } catch {
        this.abort(new Error('Failed to send SAP worker request'));
      }
    });
  }

  async open(
    assets: {
      commerceKit: Uint8Array;
      commerceCore: Uint8Array;
      coreFP: Uint8Array;
      coreFPICXS: Uint8Array;
    },
    wasmBinary: ArrayBuffer,
  ): Promise<void> {
    await this.call({
      type: 'open',
      assets: {
        commerceKit: assets.commerceKit.slice().buffer,
        commerceCore: assets.commerceCore.slice().buffer,
        coreFP: assets.coreFP.slice().buffer,
        coreFPICXS: assets.coreFPICXS.slice().buffer,
      },
      wasmBinary,
    });
  }

  async initialize(hardwareID: Uint8Array): Promise<number> {
    const copy = hardwareID.slice();
    const result = await this.call({
      type: 'initialize',
      hardwareID: copy.buffer,
    });
    return result.contextValue as number;
  }

  async exchange(
    version: number,
    hardwareID: Uint8Array,
    contextValue: number,
    input: Uint8Array,
  ): Promise<{ output: Uint8Array; state: number }> {
    const hw = hardwareID.slice();
    const payload = input.slice();
    const result = await this.call({
      type: 'exchange',
      version,
      hardwareID: hw.buffer,
      contextValue,
      input: payload.buffer,
    });
    return {
      output: new Uint8Array(result.output as ArrayBuffer),
      state: result.state as number,
    };
  }

  async sign(contextValue: number, input: Uint8Array): Promise<Uint8Array> {
    const payload = input.slice();
    const result = await this.call({
      type: 'sign',
      contextValue,
      input: payload.buffer,
    });
    return new Uint8Array(result.signature as ArrayBuffer);
  }

  async teardown(contextValue: number): Promise<void> {
    await this.call({ type: 'teardown', contextValue });
  }

  async close(): Promise<void> {
    this.abort(new Error('SAP worker is closed'));
  }
}

interface PreparedSigner {
  signer: SapSigner;
  driver: WorkerMachineDriver;
  hardwareID: string;
  endpoints: SapEndpoints;
}

let prepared: PreparedSigner | null = null;
let operation: Promise<unknown> = Promise.resolve();

// A signer is bound to one account. Hold the queue through signing too, so a
// concurrent warmup/login cannot close its worker while it is in use.
function exclusive<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const deadline = createDeadline(
    authenticationTimeoutMs,
    parent,
    i18n.t('errors.auth.timeout'),
  );
  const result = operation.then(() => {
    // A queued cancellation must never cancel another account's active work.
    throwIfAborted(deadline.signal);
    return run(deadline.signal);
  });
  operation = result.catch(() => undefined);
  return abortable(() => result, deadline.signal).finally(() =>
    deadline.dispose(),
  );
}
let wasmBinary: ArrayBuffer | null = null;

async function loadWorkerWasmBinary(signal: AbortSignal): Promise<ArrayBuffer> {
  if (wasmBinary) {
    return wasmBinary;
  }
  const url = new URL('./vendor/unicorn.wasm', import.meta.url);
  const response = await abortable(() => fetch(url, { signal }), signal);
  if (!response.ok) {
    throw new Error(`SAP engine download failed: HTTP ${response.status}`);
  }
  const binary = await abortable(() => response.arrayBuffer(), signal);
  throwIfAborted(signal);
  wasmBinary = binary;
  return wasmBinary;
}

/**
 * Returns a ready signer for the hardware id, reusing the current one when
 * it matches. Concurrent callers share a single preparation; the setup
 * network exchange rides the wisp tunnel on the main thread.
 */
export function prepareSigner(
  hardwareID: string,
  endpoints: SapEndpoints,
  signal?: AbortSignal,
): Promise<void> {
  return exclusive(async (activeSignal) => {
    await getSigner(hardwareID, endpoints, activeSignal);
  }, signal);
}

async function getSigner(
  hardwareID: string,
  endpoints: SapEndpoints,
  signal: AbortSignal,
): Promise<PreparedSigner> {
  throwIfAborted(signal);
  if (
    prepared &&
    prepared.driver.active &&
    prepared.hardwareID === hardwareID &&
    endpointsEqual(prepared.endpoints, endpoints)
  ) {
    return prepared;
  }
  return runPreparation(hardwareID, endpoints, signal);
}

async function runPreparation(
  hardwareID: string,
  endpoints: SapEndpoints,
  signal: AbortSignal,
): Promise<PreparedSigner> {
  useSapStore.getState().begin(hardwareID);

  const previous = prepared;
  prepared = null;
  let driver: WorkerMachineDriver | null = null;
  try {
    // Tear down the old signer first: the worker holds ~160 MB of wasm heap.
    if (previous)
      await abortable(
        () => previous.signer.close().catch(() => undefined),
        signal,
      );
    validateSapSignerOptions({
      ...endpoints,
      hardwareID: new TextEncoder().encode(hardwareID),
    });

    const assets = await abortable(
      () =>
        loadSapAssets((loaded, total) => {
          if (!signal.aborted)
            useSapStore
              .getState()
              .setAssets(total ? Math.round((loaded / total) * 100) : 0);
        }, signal),
      signal,
    );
    useSapStore.getState().setSetup();

    const wasm = await loadWorkerWasmBinary(signal);
    throwIfAborted(signal);
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    driver = new WorkerMachineDriver(worker);
    const activeDriver = driver;
    await abortable(() => activeDriver.open(assets, wasm), signal);

    const signer = await abortable(
      () =>
        SapSigner.create(
          {
            ...endpoints,
            hardwareID: new TextEncoder().encode(hardwareID),
            assets,
          },
          activeDriver,
          {
            fetchCertificate: () => fetchSetupCertificate(endpoints, signal),
            exchange: (input) => exchangeSetupBuffer(endpoints, input, signal),
          },
        ),
      signal,
    );
    throwIfAborted(signal);

    const result = { signer, driver, hardwareID, endpoints: { ...endpoints } };
    prepared = result;
    useSapStore.getState().setReady();
    return result;
  } catch (error) {
    await driver?.close();
    await previous?.driver.close();
    reportFailure(error);
    throw error;
  }
}

/** Signs body bytes, preparing the signer on demand. */
export async function signWithSap(
  hardwareID: string,
  endpoints: SapEndpoints,
  body: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  return exclusive(async (activeSignal) => {
    const current = await getSigner(hardwareID, endpoints, activeSignal);
    try {
      return await abortable(() => current.signer.sign(body), activeSignal);
    } catch (error) {
      prepared = null;
      await current.driver.close();
      reportFailure(error);
      throw error;
    }
  }, signal);
}

function reportFailure(error: unknown): void {
  if (isAbortError(error)) useSapStore.getState().reset();
  else
    useSapStore
      .getState()
      .setError(error instanceof Error ? error.message : String(error));
}

function endpointsEqual(left: SapEndpoints, right: SapEndpoints): boolean {
  return (
    left.certificateURL === right.certificateURL &&
    left.setupURL === right.setupURL &&
    left.version === right.version
  );
}
