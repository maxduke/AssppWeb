# SAP emulator build

The browser executes the SAP guest inside Unicorn 2.1.4, compiled to WebAssembly.
The checked-in `unicorn.mjs` and `unicorn.wasm` are generated artifacts. The source
is [Unicorn commit 8028ec4](https://github.com/unicorn-engine/unicorn/tree/8028ec436f2d9376525352dd38ed9ed6b9f6be10),
plus `frontend/scripts/unicorn-wasm-patch/patches/unicorn-2.1.4-tci-wasm.patch`
and `glue.c` in the same directory. This port was adapted from
[AssppWeb PR #89](https://github.com/Lakr233/AssppWeb/pull/89).

From the repository root, run:

```sh
bash frontend/scripts/unicorn-wasm-patch/build.sh
```

The script checks the source revision and patch digest and uses
`emscripten/emsdk:3.1.61`. Its generated checkout/build/output directories are
ignored by Git and Docker. If the patch changes, remove those generated directories
before rebuilding. The patch restores TCI, uses 64-bit virtual registers and
uniform-signature helper trampolines for wasm32, and enforces guest deadlines
across translated blocks. The glue handles signed register values explicitly.

Unicorn/QEMU and GLib licensing texts and author attribution accompany the engine
in `COPYING`, `COPYING.LGPL2`, `COPYING_GLIB`, and `AUTHORS.TXT`; they are not covered
by this application's MIT license. Apple guest binaries are fetched separately
from Apple's public update CDN and verified against fixed SHA-256 digests. They
are not committed to this directory.
