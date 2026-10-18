// Only public, digest-pinned Apple binaries are served here. Account data and
// signing requests never reach these routes.
import { Router } from 'express';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import {
  SAP_ASSET_SPECS,
  ensureSapAssets,
  readCachedAsset,
  sapAssetsState,
} from '../services/sapAssets.js';

const router = Router();
const gzip = promisify(gzipCallback);
interface ServedAsset {
  raw: Buffer;
  gzipped: Buffer;
}
const served = new Map<string, Promise<ServedAsset | null>>();

function loadServedAsset(name: string): Promise<ServedAsset | null> {
  let pending = served.get(name);
  if (!pending) {
    pending = readCachedAsset(name).then(async (raw) =>
      raw ? { raw, gzipped: await gzip(raw) } : null,
    );
    served.set(name, pending);
    pending.then(
      (asset) => {
        if (!asset) served.delete(name);
      },
      () => served.delete(name),
    );
  }
  return pending;
}

router.get('/sap-assets/status', (_req, res) => {
  res.json(sapAssetsState());
});

router.post('/sap-assets/prepare', (_req, res) => {
  void ensureSapAssets().catch(() => undefined);
  res.json(sapAssetsState());
});

router.get('/sap-assets/:name', async (req, res) => {
  const name = req.params.name;
  const spec = SAP_ASSET_SPECS.find((candidate) => candidate.name === name);
  if (!spec) {
    res.status(404).json({ error: 'Unknown SAP asset' });
    return;
  }
  try {
    let asset = await loadServedAsset(name);
    if (!asset) {
      await ensureSapAssets();
      asset = await loadServedAsset(name);
    }
    if (!asset) throw new Error('SAP asset unavailable');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('ETag', `W/"${spec.strippedSha256}"`);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.vary('Accept-Encoding');
    if (req.acceptsEncodings('gzip', 'identity') === 'gzip') {
      res.setHeader('Content-Encoding', 'gzip');
      res.send(asset.gzipped);
      return;
    }
    res.send(asset.raw);
  } catch (error) {
    res.status(503).json({
      error:
        error instanceof Error ? error.message : 'SAP asset extraction failed',
    });
  }
});

export default router;
