---
doc_id: D49
title: Packaging, release, and maintenance
status: implementation-spec
updated: 2026-11-04
depends_on: [D09, D13, D16, D19, D20, D48]
requirement_ids: [REQ-ARCH-49]
---

# Packaging, release, and maintenance

## Authority and release target

**SPECIFIED:** Deliver a privately installable Windows x64 VSIX for local desktop VS Code, accompanied by explicit dependency readiness checks and a small local companion service. A Marketplace account, cloud backend, billing system, or public publication is not required. The complete release still requires all features in [D04](scope-and-release-boundaries.md). Packaging an incomplete prototype does not change that scope.

The user's Windows 10 PC is a **VALIDATION-GATE**, not assumed compatible with whichever current runtime is newest. Record the exact tested Windows build, VS Code version, companion runtime, native-module ABI, Arduino CLI/core/compiler, and provider versions in the release matrix. If current supported tooling excludes this OS, report the narrow compatibility conflict and options; do not silently pin unsupported software or claim support from successful compilation alone.

**REQ-ARCH-49:** The personal release MUST be installable from its inspected VSIX on the recorded supported Windows environment and preserve user data through maintenance operations.

## Dependency and runtime policy

[D09](dependencies-and-compatibility.md) owns chosen versions and licenses. The implementation MUST create a lockfile after compatibility probes. The extension host MUST NOT load a native binary built for an incompatible Node/Electron ABI. Prefer isolating native serial/database bindings inside the companion runtime, but that runtime itself MUST be resolved and tested explicitly. Choose one strategy in the compatibility spike: package a permitted runtime and native dependencies, or require a detected supported local runtime with guided setup. Do not mix these strategies implicitly between development and packaged execution.

External tools are discovered by configured executable path followed by documented PATH lookup. Discovery MUST report executable identity and version without modifying installed toolchains. Missing optional KiCad/CAD tooling does not block ordinary editing or compiling. Repair actions explain the dependency being installed, disk destination, and any project effect. The app MUST NOT automatically install globally or change board-core versions because a health check failed.

The default operational data location uses a per-user application data directory, configurable to another drive through [D16](storage-and-migrations.md). Large caches and recordings MUST be relocatable. Do not assume spare space on C:. Moving data requires stopping affected jobs, validating copied data, updating configuration, and retaining the old copy until successful reopen.

## Build and package pipeline

For this documentation delivery, the existing [pack validator](../scripts/validate_pack.py), [dependency file](../scripts/requirements-validation.txt), [document manifest](../doc-manifest.json), and [bootstrap prompt](../BOOTSTRAP-PROMPT.txt) support extraction and agent startup. Validate the pack before copying it into an implementation repository. These files do not constitute the VSIX build system described below.

The following are **required pipeline stages**, not commands claimed to exist already:

1. Restore pinned development dependencies from the lockfile.
2. Validate contracts, examples, links, and requirement references.
3. Type-check and lint extension, service and webviews.
4. Run deterministic tests from D48.
5. Build extension entry point, service, webview assets and allowed native binaries.
6. Generate dependency/license inventory and remove secret/dev-only material.
7. Package the Windows target and inspect the resulting VSIX contents.
8. Install that exact VSIX in an isolated profile and run packaged smoke tests.
9. Produce SHA-256 checksums and a release evidence manifest.

The inspector bounds ZIP metadata before decompression: at most 128 MiB compressed,
256 MiB expanded, 64 MiB per entry and 2,000 entries. Encrypted and non-regular
entries are refused. Negative fixtures exercise oversized central-directory
claims, expansion/count limits, private payload paths and missing runtime files;
the actual packaged outputs must also pass exact-byte inspection. Raising these
bounds for a future package requires an explicit pipeline review.

**SOURCE-VERIFIED:** Official VS Code documentation retrieved through Context7 on 2026-11-01 documents the following commands. Run them only after the implementation provides its manifest, build outputs, and locally installed pinned packaging tool:

```powershell
vsce package --target win32-x64
code --install-extension .\robotics-workbench-0.1.0.vsix
```

The filename is illustrative. `robotics-workbench` remains a working identifier, not a final brand commitment. No `vsce publish` action belongs in the personal-release pipeline. Package allowlisting/exclusion rules MUST preserve runtime assets and native modules while excluding development fixtures, caches, logs, credentials and user projects. Blindly excluding all `node_modules` is incorrect if any externalized runtime dependency remains.

## Release manifest

Create a release record with at least:

```json
{
  "schemaVersion": 1,
  "releaseVersion": "0.1.0",
  "target": "win32-x64",
  "sourceCommit": "record-at-build",
  "vsixSha256": "record-after-packaging",
  "compatibilityMatrix": "compatibility.json",
  "testReport": "verification.json",
  "migrationFrom": [],
  "knownLimitations": []
}
```

Placeholder values in this example are invalid in a real release. Record checksums of packaged companion/native binaries as well as the VSIX. A hash proves identity, not trustworthiness. Avoid automatically trusting a downloaded replacement merely because it includes its own checksum.

## Installation, update and rollback

First launch MUST detect tool readiness lazily, open existing sketches without forced migration, and separate setup history from current health. No login is required to edit or run an already-installed offline compiler. Remote SSH, WSL, containers and browser-hosted VS Code MUST show an explicit unsupported/gated device boundary until separately tested; a remote extension host is not the local USB machine.

Before a schema-changing update, stop mutations, back up operational data, record the old/new schema and app versions, then perform the migration. On failure, preserve the original data and enter recoverable read-only mode with a specific repair action. Downgrading the VSIX MUST NOT open a newer database read-write unless explicitly supported. Restoring an older backup is a user-visible action, not automatic data deletion.

Source rollback, application rollback, database restore, firmware restore and physical rewiring are distinct operations. Uninstall MUST leave sketches and operational evidence intact by default. An explicit purge action must enumerate affected data, exclude provider-managed credentials it does not own, and avoid deleting unrelated project directories.

## Diagnostics and maintenance

Provide a locally generated diagnostic bundle containing app/tool versions, sanitized configuration, recent operation receipts, bounded redacted logs and storage health. Exclude source, raw serial captures, document text and provider transcripts by default; include them only through an explicit selection preview. Do not collect telemetry by default for this personal app.

For upgrades, rerun affected adapter contract fixtures and the smallest relevant live compatibility probe. New provider version support requires observed capability negotiation, not only a version-string allowlist. Scheduled background updates are not required. Document a troubleshooting decision table for missing executable, ABI load failure, busy port, provider authentication failure, corrupt index, full disk, and interrupted migration; each entry links to the owning subsystem recovery procedure.

## TASK-12 implementation and remaining acceptance

The [private installation and troubleshooting guide](personal-installation-and-troubleshooting.md)
documents native installation, machine path settings, data preservation, explicit
backup restore and the local diagnostic-preview/export command. Developer-only
maintenance commands are identified separately from installed-extension actions.

`scripts/release/maintenance-drill.mjs --self-test` exercises real SQLite migration
failure, read-only backup verification/restoration, unsupported-newer-schema
protection and bounded synthetic ZIP/path checks without launching VS Code.
`--execute --vsix <exact-inspected-vsix>` performs the isolated installed-package
drill after native/companion ownership has been released. All writes stay in a
new `artifacts/task12-maintenance/<runId>` tree. Actual source/database/artifact
hashes are compared around install, version change and uninstall. The installed
companion core-open and newer-schema-refusal probes are separate from CLI success
and from the installed VS Code extension-host/UI checks.
The preservation inventory also includes a closed synthetic store in the isolated
profile's conventional global-storage location, without claiming actual host
`ExtensionContext` path resolution.

There is no previously shipped release. The `0.0.0` maintenance VSIX is explicitly
synthetic: only the package and VSIX identity version manifests change, with
runtime bytes verified unchanged. It exercises actual version install mechanics,
not historical application migration or schema compatibility. Execution results
belong to [TASK-12's evidence record](../tasks/TASK-12.md); these instructions alone
do not establish a passing drill or accepted release.

Local success on Windows 10 Education build 19045 does not resolve vendor OS
support. VS Code's current requirements refer to supported Windows clients, and
Microsoft records Windows 10 22H2/build 19045 as beyond ordinary servicing since
2025-10-14. Node 24.18.0's platform policy excludes vendor-end-of-life platforms.
ESU eligibility and extended-support applicability were not verified. Retain that
compatibility gate alongside the incomplete TASK-11 native accessibility evidence;
do not alter the OS/runtime or weaken the gate to label G6 accepted. Primary
sources are linked in the installation guide.

## Acceptance criteria

- **AC-D49-01:** The exact packaged VSIX installs and opens on the recorded Windows machine without relying on developer checkout files.
- **AC-D49-02:** Serial/database native dependencies work under the declared runtime; unsupported hosts fail with a useful message.
- **AC-D49-03:** Package inspection detects accidental credentials, recordings, source fixtures and missing runtime assets.
- **AC-D49-04:** Failed migration retains a restorable backup; unsupported downgrade cannot modify newer data.
- **AC-D49-05:** Uninstall preserves user projects/evidence; diagnostic export excludes private payloads by default.
- **AC-D49-06:** Private installation and complete-release evidence require no Marketplace publication.

## Sources and related documents

- SOURCE-VERIFIED: [Publishing and packaging extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) and [bundling extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension), Context7 retrieval 2026-11-01.
- RESEARCH-RECORDED: [Remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions), prior research 2026-10-31; runtime/native dependency and host-location caveats.
- [D48 verification](testing-and-requirement-traceability.md); [D50 delivery plan](implementation-plan-and-task-packets.md).
