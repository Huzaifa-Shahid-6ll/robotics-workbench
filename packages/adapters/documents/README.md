# Document adapter

`extractDocument(bytes, mediaType, options?)` returns immutable hash/version/page
provenance. `renderDocumentPage(bytes, physicalPage, options?)` paints an actual
page to a bounded PNG; active document content is never evaluated or followed.
The caller retains originals before invoking either method.

PDF.js 6.5.438 and `@napi-rs/canvas` 1.1.0 are loaded only inside the requested
worker. The packaged worker uses its own `vendor/node_modules`, not the project.
Built-in fonts, CMaps and decoders resolve through filename-only local assets;
network retrieval and automatic system-font loading are disabled. This is a
bounded parser process, not a complete OS security sandbox.

Limits: 32 MiB input, 2000 physical pages, 256 KiB text/page, 8 MiB total text,
20,000 regions/page, 100,000 total regions, 192 MiB V8 old-generation heap and
20-second hard deadline. Native decoder allocations are separate from V8.
Previews are at most 1600 pixels per dimension and 480 KiB PNG bytes; images above
16 million pixels or unsupported PDF features may be omitted, as disclosed in
the extraction limitations. They are inspection aids, not fidelity certification.
Text is UTF-8 only and uses logical page 1 without invented PDF geometry.

OCR, numeric-fact promotion, general table reconstruction and remote fetching
remain outside this adapter. Missing text, encrypted input, malformed bytes,
encoding/size/deadline limits and unavailable runtimes have distinct errors.
`scripts/native-runtime.mjs` stages exact Windows x64 dependencies and licenses
with a verified SHA-256 inventory. Tests use synthetic sources, never a measured
electrical fact or private document.
