import { useEffect } from 'react';
import { useAccountsStore } from '../store/accounts';
import { fetchBag } from '../apple/bag';
import { abortable, createDeadline } from '../utils/abort';
import { authenticationTimeoutMs } from '../apple/config';
import i18n from '../i18n';

// Starts preparing the SAP signer in the background once an account exists.
//
// Preparation loads approximately 24 MB of assets (cached after first use),
// so starting it on load means sign-in usually
// finds the signer ready. It waits for an account because the signer is
// bound to the hardware id it was initialized with. Fire and forget: the
// store carries the outcome, and a failure here should not surface until
// something actually needs a signature.
export function useSapWarmup() {
  const device = useAccountsStore(
    (state) =>
      state.accounts.find((account) => account.deviceIdentifier)
        ?.deviceIdentifier,
  );

  useEffect(() => {
    if (!device) {
      return;
    }

    const controller = new AbortController();
    const deadline = createDeadline(
      authenticationTimeoutMs,
      controller.signal,
      i18n.t('errors.auth.timeout'),
    );
    abortable(() => fetchBag(device, deadline.signal), deadline.signal)
      .then(async (bag) => {
        if (!bag.sapEndpoints) {
          return; // bag without SAP keys: legacy flow, nothing to warm up
        }
        const { prepareSigner } = await abortable(
          () => import('../apple/sap/client'),
          deadline.signal,
        );
        await prepareSigner(device, bag.sapEndpoints, deadline.signal);
      })
      .catch(() => {
        // warmup is best-effort; sign-in will retry and surface real errors
      })
      .finally(() => deadline.dispose());
    return () => {
      controller.abort();
      deadline.dispose();
    };
  }, [device]);
}
