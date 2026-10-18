// Shared SAP types.

export interface SapEndpoints {
  /** GET endpoint returning the Apple certificate plist (bag: sign-sap-setup-cert). */
  certificateURL: string;
  /** POST endpoint for the setup key exchange (bag: sign-sap-setup). */
  setupURL: string;
  /** Protocol version from the bag (sign-sap-version); only 200 is supported. */
  version: number;
}

export const SUPPORTED_SAP_VERSION = 200;

export interface SapAssetBundle {
  commerceKit: Uint8Array;
  commerceCore: Uint8Array;
  coreFP: Uint8Array;
  coreFPICXS: Uint8Array;
}

export interface SapSignerOptions extends SapEndpoints {
  /** Per-account device identifier bytes (ASCII, 1..20 bytes). */
  hardwareID: Uint8Array;
  assets: SapAssetBundle;
  wasmBinary?: ArrayBuffer;
}

/** Endpoint/hardware validation matching the Swift reference. */
export function validateSapSignerOptions(
  options: SapEndpoints & { hardwareID: Uint8Array },
): void {
  if (options.version !== SUPPORTED_SAP_VERSION) {
    throw new Error(`unsupported SAP version ${options.version}`);
  }
  if (options.hardwareID.length === 0 || options.hardwareID.length > 20) {
    throw new Error('SAP hardware ID must contain between 1 and 20 bytes');
  }
  for (const [url, expectedHost] of [
    [options.certificateURL, 's.mzstatic.com'],
    [options.setupURL, 'fpinit.itunes.apple.com'],
  ]) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== expectedHost ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error('Invalid Apple SAP setup endpoint');
    }
  }
}
