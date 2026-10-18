import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';

let root: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'assppweb-sap-'));
  vi.stubEnv('DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('BUNDLED_SAP_ASSETS', path.join(root, 'bundled'));
  await fs.mkdir(path.join(root, 'bundled'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const service = await import('../src/services/sapAssets.js');
  // Exercise real cache hashing/copying with small fixtures, without the CDN.
  service.SAP_ASSET_SPECS.splice(
    0,
    service.SAP_ASSET_SPECS.length,
    ...['A', 'B'].map((name) => ({
      name,
      archivePath: name,
      size: 1,
      sha256: '',
      strippedSize: 1,
      strippedSha256: createHash('sha256').update(name).digest('hex'),
    })),
  );
  return service;
}

describe('SAP asset preparation', () => {
  it('shares preparation and seeds a complete verified bundle without network', async () => {
    const service = await fixture();
    const network = vi.spyOn(https, 'get').mockImplementation(() => {
      throw new Error('Unexpected network');
    });
    await Promise.all(
      ['A', 'B'].map((name) =>
        fs.writeFile(path.join(root, 'bundled', name), name),
      ),
    );
    const first = service.ensureSapAssets();
    expect(service.ensureSapAssets()).toBe(first);
    await first;
    expect(service.sapAssetsState()).toEqual({ status: 'ready' });
    expect((await service.readCachedAsset('B'))?.toString()).toBe('B');
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['missing', 'corrupt'])(
    'does not mark a partial %s bundle ready and permits a retry',
    async (kind) => {
      const service = await fixture();
      await fs.writeFile(path.join(root, 'bundled', 'A'), 'A');
      if (kind === 'corrupt')
        await fs.writeFile(path.join(root, 'bundled', 'B'), 'X');
      const network = vi.spyOn(https, 'get').mockImplementation(() => {
        throw new Error('CDN unavailable');
      });
      await expect(service.ensureSapAssets()).rejects.toThrow(
        'CDN unavailable',
      );
      expect(service.sapAssetsState().status).toBe('error');
      expect(network).toHaveBeenCalledOnce();
      await fs.writeFile(path.join(root, 'bundled', 'B'), 'B');
      await service.ensureSapAssets();
      expect(service.sapAssetsState().status).toBe('ready');
    },
  );
});
