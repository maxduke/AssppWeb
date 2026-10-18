# Apple service compatibility: upstream PR review

Reviewed on 2026-10-18 against fork/upstream main `3bc9515`. The two main branches
were identical: this failure was not caused by a missed main-branch sync.
All seven open upstream PRs were inspected, including their current patches,
tests and discussion. Overlapping alternatives were compared before adaptation.

| Upstream PR and reviewed HEAD | Decision | Reason |
| --- | --- | --- |
| [#88](https://github.com/Lakr233/AssppWeb/pull/88), `93b47d5` | Do not integrate its engine | Useful diagnosis and client-side signing design, but its instruction splitting and slower emulator duplicate #89. Retain its browser compatibility and memory validation criteria. |
| [#89](https://github.com/Lakr233/AssppWeb/pull/89), `835a54d` | Adapt and repair | Browser Worker + faster WASM signing preserves the credential boundary. Original patch misses Wisp hosts and has lifecycle, extraction/cache and synchronous compression defects. |
| [#90](https://github.com/Lakr233/AssppWeb/pull/90), `951528e` | Adapt and tighten | Shared download/version request path validates identity on every success and selects an iOS catalog offer. Requires narrower empty-response classification and CDN URL checks. |
| [#91](https://github.com/Lakr233/AssppWeb/pull/91), `500e1c4` | Integrate with endpoint validation | Correctly normalizes legacy authentication trailing slashes and relative redirects. Added explicit HTTPS/host/path checks before replaying a credential body. |
| [#92](https://github.com/Lakr233/AssppWeb/pull/92), `01999fc` | Use selected regression scenarios | Duplicates #90. Its original implementation validates identity only after recovery, accepts broader redirects, and can select an offer without confirming iOS assets. Caller-level tests informed our coverage. |
| [#93](https://github.com/Lakr233/AssppWeb/pull/93), `9d0a370` | Adapt with SAP integration | Bound transient HTTP retries and expose their wait in sign-in/re-authentication. Sign each replay, preserve cookies/body, and avoid the old catch-all retry loop. |
| [#94](https://github.com/Lakr233/AssppWeb/pull/94), `a6d3a7a` | Integrate with an error-priority guard | `5002` on buyProduct means an already-owned license; preserve real failures and expired-password handling. This meaning is specific to purchase, not download endpoints. |

## Protocol evidence

The ignored `references/ApplePackage` checkout was consulted for the existing
Configurator payload, per-account GUID/cookies, pod routing, error handling and
software fields. Its older unsigned authentication behavior is insufficient for
the current service. Current primary sources from
[ipatool](https://github.com/majd/ipatool) were also checked:

- `internal/sap/protocol.go`: certificate and setup exchange plist keys, version
  200, and public setup data.
- `pkg/appstore/appstore_login.go`: signed requests, bounded transient retry,
  relative trusted redirects, and rejection of incomplete authentication results.
- `pkg/appstore/constants.go`: buyProduct `5002` means an existing license.
- `pkg/appstore/appstore_download_product.go`: recover only availability failures;
  preserve version IDs and verify item/bundle/version identity.

A live public catalog probe for TestFlight returned `kind=iosSoftware` and an
`iosSoftware` asset with an external version ID. Catalog calls use the account's
storefront and do not send cookies, DSID or tokens.

## Improvements made during integration

Signing remains entirely inside the browser: the server serves public, verified
binaries and relays encrypted TCP. Added only the exact SAP/certificate/catalog
hosts to Wisp's allowlist; the HTTPS-only port and direct-IP/loopback restrictions
remain in place. Authentication fails before sending credentials if the bag has
no usable signing configuration. Replays sign the exact UTF-8 bytes sent and
preserve the serialized body across redirects. Only known HTTPS authentication
hosts and paths can receive it.

Signer preparation and signing share a queue, preventing concurrent accounts from
closing a worker during another signature. Worker crash/message errors and timeouts
settle pending promises and permit a new attempt. Failed preparation releases its
worker. Browser cache failures are optional and cannot discard verified resources.
Assets use digest-versioned URLs and size/digest verification in both tiers.

The server verifies/compresses each immutable asset once and shares asynchronous
compression across requests. It honors encoding preferences and varies responses
by Accept-Encoding. Preparation is shared across concurrent requests, and a partial
or corrupt bundled cache cannot be marked ready. CDN reads have size bounds and
timeouts; all extraction stream errors are observed, with in-flight reads aborted
when extraction finishes.

The emulator was rebuilt from the pinned source and supplied patch. Review also
found that the upstream guest timeout counter reset for each translated block;
the corrected counter spans blocks. Negative guest register values now cross the
C/WASM boundary without an out-of-range floating-point to unsigned conversion.
Source/build instructions and upstream license texts accompany the generated engine.

Download, version listing and version metadata lookup now share the same recovery
path. Only known empty lists, `5002` and explicit unavailability trigger recovery;
malformed responses and token/license/rate-limit/other HTTP errors retain their
meaning. Unpinned recovery selects a storefront iOS version; explicit historical
IDs never change. Successful primary and recovery responses validate app, bundle,
requested version and HTTPS Apple CDN URL. Error diagnostics omit response bodies
and query values. Exported iTunesMetadata excludes passwordToken.

Added CI for tests, frontend type checking and production builds. Fixed the existing
Web Crypto BufferSource type error using an owned Uint8Array. Docker uses Node 22,
separates target-native runtime dependencies, and preloads the pinned public assets.
The fork's deployment examples use its own GHCR image.

## Validation and remaining acceptance

Local verification: 163 frontend tests passed, followed by 22 focused tests after
five additional regressions (168 total); all 57 backend tests passed. Frontend type
checking and both production builds passed. The engine was rebuilt from source,
and live Chromium/WebKit probes each observed unsigned HTTP 403 versus signed
HTTP 200, a parseable plist, a 501-byte signature, and HTTP 200 on the actual
authenticate call with an intentionally invalid identity. Backend logs contained
tunnel metadata and neither probe email/password nor credential headers.
The production Docker image built successfully. Chromium and WebKit each passed
the password-protected production UI flow: access gate, authenticated assets,
authenticated Wisp connection and signed login reaching the verification step.
Unauthenticated asset requests returned HTTP 401. These probes used an explicitly
invalid identity, not a real account. Regression coverage includes
signed-byte/redirect identity, retry limits, missing signing config, account switches,
worker crash/hang recovery, partial caches, asynchronous asset delivery, exact historical
version recovery, catalog credential omission, primary-response identity mismatches,
CDN URL validation and endpoint-specific license handling.

Real-account credentials were not available in this workspace. Public SAP handshake
and deliberately invalid-identity probes can prove that signed requests reach Apple's
credential parser; they cannot prove real-account login/2FA, license acquisition,
a full IPA download or installation. Physical iPhone memory behavior also needs device
acceptance. No release tag or production deployment is implied by these local probes.
