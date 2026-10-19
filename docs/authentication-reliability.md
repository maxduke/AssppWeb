# Authentication reliability

The authentication changes keep browser-side SAP signing and the existing
digest-pinned assets. They address credential retry semantics, Apple error
priority and cancellation of work that could otherwise leave sign-in waiting.

## Credential attempts and replay

The legacy Swift checkout in `references/ApplePackage` sends attempt `4` without
a verification code and `2` with one. The newer signed flow in
[ipatool at 5dc4c80](https://github.com/majd/ipatool/blob/5dc4c8058db3a23e9de081ac766cc917713a65cf/pkg/appstore/appstore_login.go)
starts at `1`, with a single retry at `2` for failureType `-5000`. AssppWeb now
follows that sequence both with and without a verification code, matching the
current native Asspp implementation.

Each credential attempt serializes its plist once. Transient HTTP retries and
trusted redirects keep that same body and UTF-8 byte array, retain updated cookies
and obtain a new SAP signature for every actual send. Only the explicit first
`-5000` regenerates the body with attempt `2`. A second `-5000` is returned to the
user. Existing trusted authentication host/path validation still applies.

A parsed Apple dictionary containing `failureType`, `customerMessage`, a dialog
explanation or account information takes priority over transient HTTP handling.
For example, a verification failure on HTTP 503 is shown immediately, even if
Retry-After is present. Error `5005` and Configurator's verification challenge
keep the verification input available for another code. Empty or unstructured
transient responses retain the existing bounded retries and visible wait state.

## Cancellation and ownership

The five-minute total deadline starts at authentication entry, before fetching
the bag. It covers queue waiting, Cache API access, asset download and hashing,
WASM download, Worker setup/signing, SAP HTTP exchange, authentication HTTP/body
reads and retry backoff. Direct SAP preparation/signing callers have the same
bound. Existing shorter setup HTTP and Worker-call limits still apply.

AbortSignal is passed to cancellable browser operations. Non-cancellable work
(such as Cache API access or shared libcurl initialization) is raced against
cancellation, and late results are observed without continuing the cancelled
flow. Asset streams release their reader; a stalled stream cancellation cannot
hold the signer queue open. Partial/unverified bytes are never cached as valid.

The queue owns active cleanup. Cancelling a queued caller rejects that caller
without touching the current account's Worker. Cancelling active preparation
or signing closes its own Worker and allows the next call to prepare afresh.
Late progress/results cannot replace another account's state. Completed signers
remain reusable for subsequent requests.

Sign-in and re-authentication expose Cancel while pending. Cancel preserves
entered values, and leaving the screen aborts its current operation. Cancelled
responses cannot start an account write or show a late success/error toast.
Deleting an account is disabled during re-authentication. IndexedDB writes
already started after successful authentication retain their normal commit
semantics; cancellation does not roll back a committed account.

Background warmup has its own lifetime and deadline. Its effect depends on the
selected device ID, so progress updates cannot cancel its own preparation.

## Verification

Regression tests cover credential attempts with/without 2FA, mixed retry and
redirect sequences, signed-byte identity and cookies, structured errors on
429/503, stalled bag/libcurl/response/cache/asset/WASM operations, Worker
cancellation and queue isolation, warmup lifetime, and both account screens.

Unit tests and deliberately invalid-identity browser probes cannot prove a real
account's successful login/2FA or physical iPhone memory behavior. Acceptance
still includes a real-account add/reauthentication, fresh verification code,
and cancel/retry on a slow connection in the target browser.

Validated on 2026-10-19: all 199 frontend and 57 backend tests, frontend type
checking, both production builds and the Docker image build passed. Chromium
and WebKit each passed the password-protected production UI flow: cancellation
of a stalled bag lookup, cancellation of a stalled asset request, retained input
and successful retry through SAP setup/signing to Apple's verification prompt
using an intentionally invalid identity. Neither browser reported page errors
or stored an account. Protected assets required the access header. These checks
do not imply successful real-account authentication or a production deployment.
