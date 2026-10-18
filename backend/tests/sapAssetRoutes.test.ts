import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ensureSapAssets, readCachedAsset } from '../src/services/sapAssets.js';
import routes from '../src/routes/sapAssets.js';

vi.mock('../src/services/sapAssets.js', () => ({
  SAP_ASSET_SPECS: ['cached', 'missing', 'failure', 'encoding'].map((name) => ({
    name,
    strippedSha256: name,
  })),
  ensureSapAssets: vi.fn(),
  readCachedAsset: vi.fn(),
  sapAssetsState: () => ({ status: 'idle' }),
}));
const app = express().use('/api', routes);
beforeEach(() => {
  vi.resetAllMocks();
});

describe('SAP asset delivery', () => {
  it('shares a verified/compressed buffer across concurrent requests', async () => {
    vi.mocked(readCachedAsset).mockResolvedValue(
      Buffer.from('public Apple fixture'),
    );
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app)
          .get('/api/sap-assets/cached')
          .set('Accept-Encoding', 'identity'),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.vary).toBe('Accept-Encoding');
      expect(response.body.toString()).toBe('public Apple fixture');
    }
    expect(readCachedAsset).toHaveBeenCalledOnce();
  });

  it('retries missing files after preparation and does not cache failed reads', async () => {
    vi.mocked(readCachedAsset)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(Buffer.from('ready'));
    expect((await request(app).get('/api/sap-assets/missing')).status).toBe(
      200,
    );
    expect(ensureSapAssets).toHaveBeenCalledOnce();
    vi.mocked(readCachedAsset).mockRejectedValueOnce(
      new Error('temporary read failure'),
    );
    expect((await request(app).get('/api/sap-assets/failure')).status).toBe(
      503,
    );
    vi.mocked(readCachedAsset).mockResolvedValue(Buffer.from('ready'));
    expect((await request(app).get('/api/sap-assets/failure')).status).toBe(
      200,
    );
  });

  it('respects gzip;q=0 and negotiates compressed responses', async () => {
    vi.mocked(readCachedAsset).mockResolvedValue(
      Buffer.from('public Apple fixture'),
    );
    const identity = await request(app)
      .get('/api/sap-assets/encoding')
      .set('Accept-Encoding', 'gzip;q=0, identity');
    expect(identity.headers['content-encoding']).toBeUndefined();
    const compressed = await request(app)
      .get('/api/sap-assets/encoding')
      .set('Accept-Encoding', 'gzip');
    expect(compressed.headers['content-encoding']).toBe('gzip');
    // Superagent transparently decodes the body.
    expect(compressed.body.toString()).toBe('public Apple fixture');
  });

  it('rejects unknown names without preparation or disk access', async () => {
    expect((await request(app).get('/api/sap-assets/unknown')).status).toBe(
      404,
    );
    expect(readCachedAsset).not.toHaveBeenCalled();
    expect(ensureSapAssets).not.toHaveBeenCalled();
  });
});
