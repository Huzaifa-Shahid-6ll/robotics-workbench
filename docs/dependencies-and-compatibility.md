---
doc_id: D09
title: "Dependencies and compatibility"
status: implementation-spec
updated: 2026-11-01
depends_on: [D08]
requirement_ids: [REQ-PROD-01, REQ-ARCH-05, REQ-UX-06]
---

# Dependencies and compatibility

TASK-10 native compatibility was exercised on Windows x64 with the isolated
KiCad 10.0.8 CLI, Python 3.11.0, CadQuery 2.8.0 and OCP 7.9.3.1.1. Exact executable,
source/output and environment hashes belong to `verification/task-10.json` and its
retained native inventory. The independently displayed STEP used OCP Viewer 1.2.0's
documented standalone workflow; VS Code's OCP extension was not installed or
controlled through private commands. Tool absence remains feature-local.

Initial PATH/common-installation discovery did not locate KiCad. A later desktop
inventory exposed an existing `F:/KiCad` installation; it was left untouched, its
different executable hash recorded, and its bounded version probe did not finish.
The tested compatibility environment is the separate exact installation on G:.
No global Python, existing KiCad or Arduino dependency upgrade was performed.

## Purpose and authority

**SPECIFIED:** This document owns dependency roles and version-selection rules. It does not invent installed versions or declare an untested combination supported. Exact versions become supported only after G0/G1 compatibility evidence is recorded and lockfiles/installation metadata are updated together. D49 owns packaging execution; D10 owns unresolved compatibility spikes.

## Candidate dependency matrix

| Role | Selected direction | Required evidence before pinning |
|---|---|---|
| Host | Desktop VS Code stable APIs, local Windows workspace | Minimum engine version supports used APIs; packaged VSIX tested |
| Extension | TypeScript, bundled JavaScript | Compiler/bundler/test versions locked; activation and CSP tests |
| Local companion | Node runtime with typed IPC | Windows x64 executable/runtime behavior; serial/SQLite native ABI compatibility |
| UI | React for necessary webviews; native host UI otherwise | Bundled offline assets, accessible controls, theme variable support |
| Wiring canvas | React Flow interaction layer | License/current version check; graph interaction and performance fixture |
| State | SQLite metadata plus file artifacts | Chosen binding loads in packaged runtime; migrations/recovery tested |
| Firmware | Arduino CLI plus project-required cores/libraries | Existing sketch baseline; exact artifact association; offline behavior |
| Language intelligence | Arduino Language Server and compatible clangd | Multi-tab sketch diagnostics and selected FQBN behavior |
| Serial | SerialPort-compatible adapter | Driver/enumeration/open/close/reset/cancel tests on actual Uno |
| Agents | Codex app-server and one OpenCode server/SDK path | Versioned handshake, capabilities, event parsing and authentication tests |
| Schematics | KiCad CLI and native editor | Supported version's generation/validation/export commands tested |
| Mechanical | Isolated Python + CadQuery/OCP; existing viewer preferred | Interpreter/package wheel compatibility, preview/export and clean failure |
| Documents | PDF.js/text extraction; SQLite FTS5 where available | Page anchors and extraction limitations tested; no invented OCR accuracy |
| Plots | uPlot or verified lightweight equivalent | Accessible alternatives, gaps/time-basis handling, bounded rendering |

These are dependency roles, not permission to install every package immediately. Optional tools start only when their capability is used.

## Version record

### Observed TASK-05/TASK-06 additions — 2026-11-02

The lockfile pins MCP SDK1.32.2 and React/React DOM19.3.1; Playwright1.61.1
is test-only. Isolated installed Edge156.0.4314.58 rendered the exact packaged
agent JS/CSS in the TASK-06 UI procedure. VS Code1.144.0 installed-host checks
passed in trusted and restricted profiles. See verification/task-05.json and
verification/task-06.json for exact commands and scoped results. These checks
do not establish Windows screen-reader, physical hardware, or G6 release success.

### Observed TASK-00/TASK-01 baseline — 2026-11-01

Actual environment: Windows 10 Education x64 10.0.19045, i5-9500, approximately
16 GiB installed RAM. See [task evidence](../verification/task-00-01.json) and
[progress](../tasks/TASK-00-01.md); version presence alone is not a compatibility pass.

| Role | Observed/selected version | Evidence scope |
|---|---|---|
| VS Code | 1.144.0 x64, commit 2c33b50b16c472efe58357d1d2a8a5414bc23fbf | Development and installed-VSIX trusted/restricted host tests |
| Companion | Existing `C:/nvm4w/nodejs/node.exe`, 24.18.0 | Inherited JSON IPC, ownership refusal, reconnect and observed shutdown |
| Package manager | Existing npm 11.16.0 | Single root package-lock.json; clean `npm ci --ignore-scripts` |
| Compiler/bundler | TypeScript 5.9.3, esbuild 0.28.2 | Project-local, strict check and bundled entry points |
| Validation | Python 3.11.0; isolated jsonschema 4.26.0 | Documentation and contract fixtures only |
| Host test/package tools | @vscode/test-electron 3.1.0, @vscode/vsce 4.1.0 | Reuse installed host; isolated profiles; inspected private VSIX |
| Schema validator | Ajv 8.20.0, ajv-formats 3.0.1 | Lifecycle boundary and D18 response schema; bundled notices included |
| Arduino | IDE-bundled CLI 1.5.1; installed arduino:avr 1.8.8 | Synthetic Uno compile only; no existing-sketch or physical claim |
| Codex | Existing CLI 0.160.1, native Windows | Actual gpt-6.1-sol reply, observed interrupt, process restart/thread resume without duplicate turn |
| OpenCode | Existing executable + SDK 1.18.32, native Windows | Actual OpenAI gpt-6.1-sol reply/abort/event reconnect; pure mode selected for bounded probe |
| Native serial candidate | @serialport/bindings-cpp 13.0.1 | Installed fixture VSIX loads Windows N-API binary; owned ordinary file rejected, no board accessed |
| Native SQLite candidate | Node built-in SQLite 3.53.1 | Installed fixture VSIX performs durable reopen and transaction rollback through local Node 24.18.0 |

Selected D49 runtime strategy: require a detected local Node 24 runtime, minimum
24.18.0, instead of redistributing Node or loading native modules in Electron.
Only the recorded combination has local evidence. The executable setting is
machine-scoped and is ignored for execution until Workspace Trust permits it.
No global executable, PATH entry, core, library or provider configuration was upgraded.
WSL was not selected. CAD/EDA adapters and dependencies remain uninstalled.

The companion uses inherited IPC for control and a Windows named pipe solely as
an exclusive owner reservation. The reservation accepts no commands and provides
no protection against unrelated applications using a device. Project operations,
SQLite repositories and serial handles are not implemented in this shell.
The original in-memory `node:sqlite` probe was followed by a separately packaged,
installed native fixture under the same chosen local Node runtime. That fixture
passed durable SQLite reopen/rollback and native serial load/ordinary-file failure
handling, including an assertion that no runtime module resolves outside its
installed VSIX. This passes VG-07's packaging scope; real serial success, USB,
reset and contention remain VG-06/VG-14. The production extension still exposes
no hardware operation and redistributes no native dependency in this increment.

### TASK-00 completion evidence

[The completion record](../verification/task-00-completion.json) supersedes the
initial remaining TASK-00 gates. VG-01, VG-02, VG-03, VG-05 and VG-07 have passing
evidence for this tested combination; VG-04 is conditionally not-run because no
WSL workaround was selected. No physical gate is marked passed.

An existing Arduino IDE Blink example was copied, without conversion, into a
project-local build directory and compiled for `arduino:avr:uno`. Both original
files and their copies retain identical SHA-256 values. CLI 1.5.1, AVR core 1.8.8,
resolved build settings, effective Arduino directories, verbose compiler commands
and artifact hashes are retained. The compiler is the existing AVR GCC
7.3.0-atmel3.6.1-arduino7 package observed in the build log. This is a pre-existing
installed example; the searches did not locate a personal user sketch. It does
not establish a physical Uno identity or validate a user's robot firmware.

Codex used its existing configured gpt-6.1-sol / OpenAI / ChatGPT route. OpenCode
had several connected providers and no configured default model; the explicit
probe selected the same model through its existing OpenAI OAuth connection.
The first OpenCode attempt failed with `Token refresh failed: 401`; the user
completed the provider-controlled sign-in, after which the same route passed.
No private credential file was read or copied and no API-key/other-account fallback
was selected. OpenCode external plugins are disabled in this tested pure-mode
path; plugin-specific behavior is not claimed. Normal build/test/verify commands
do not submit model turns. The live lifecycle scripts require `--live`.

The SDK and serial binding are pinned development-only dependencies used by
compatibility spikes. They are not production adapters. TASK-05 still owns both
provider adapters, complete approval/error contracts and the common agent UI;
TASK-03/TASK-04 still own coordinated physical-device operations. Supported here
means this bounded compatibility combination, not complete-release acceptance.

Development-only vsce dependency minimatch is overridden to 11.0.3 after npm
reported GHSA-g3hv-75wg-m249. Actual package/inspection tests validate that
combination; the final audit has zero reported vulnerabilities. Bundled code's
exact dependency/license inventory is generated during packaging. No fonts,
screenshots, native dependencies or Node executable are redistributed.

SOURCE-VERIFIED API references retrieved through Context7 for this increment:
[VS Code bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension),
[host testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension),
[Node 24 child processes](https://nodejs.org/docs/latest-v24.x/api/child_process.html),
[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html),
[Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server),
[OpenCode 1.18.29 server documentation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/web/src/content/docs/server.mdx).
Installed release help/generated schemas and real local responses take precedence
over moving documentation. Provider lifecycle, packaged native-library and
existing-example compile results are linked above. Real USB/serial/reset, actual
firmware uploads, user-project workflows and remaining release gates still require
their own evidence.

Every executable integration MUST persist an observed path, version output, platform/architecture, selected configuration, and validation date. A supported combination record additionally identifies tests and evidence. Do not compare executable basenames alone; two different installations can have the same command name.

```json
{
  "tool": "arduino-cli",
  "executablePath": "<resolved absolute path>",
  "observedVersion": "<captured version output>",
  "compatibility": "unverified",
  "validatedAt": null,
  "evidenceRefs": []
}
```

Placeholders in this illustrative record MUST be replaced by observations before it can be marked compatible. Exact runtime versions belong in the implementation lockfile and compatibility report, not guessed values in a static planning document.

## Installation and upgrade rules

Detect existing installations read-only first. Preserve effective Arduino sketchbook/library locations. Offer isolated managed installations when necessary, with exact destination and download provenance. Do not modify global PATH, upgrade unrelated packages, move sketches, or delete Arduino IDE data as an implicit repair.

Large caches/tools/recordings use a selected writable data root; a missing drive is an error, not permission to fill C:. Temporary paths should be configurable where supported, without promising that all operating-system writes can be relocated. CAD uses an explicit selected interpreter and isolated environment rather than whatever `python` resolves to.

Stage upgrades separately and retain the last known working combination until smoke tests pass. A provider version change triggers adapter-contract tests. A core/library change invalidates relevant build currency even when source text is unchanged. Native module ABI failures must be caught before enabling hardware actions.

## Authentication and licensing

Reuse provider-managed login and supported configuration. Never copy another extension's private credentials or assume a chat subscription is an unrestricted API key. D25 defines provider-specific account routing. A license inventory MUST record selected package version, source, license text/location, redistribution obligations, and whether bundled binary/font assets are included. Reusing concepts from Refero does not grant a license to redistribute proprietary fonts or product screenshots inside the shipped extension.

## Failure and recovery

Missing dependencies disable only their feature. Version parsing failure yields unknown compatibility, not assumed compatibility. Checksum/signature failures stop installation. Interrupted installs retain recoverable staging information; they never report success until executable and smoke tests pass. Native and WSL paths are not interchangeable; any WSL provider workaround requires the D10 boundary spike.

## Acceptance criteria

- **AC-D09-01:** A packaged clean-machine test can enumerate exact paths/versions without relying on the developer's global environment.
- **AC-D09-02:** Changing a core or local library invalidates the relevant prior build record.
- **AC-D09-03:** Failed upgrade leaves the previous working tool selectable and preserves project data.
- **AC-D09-04:** License inventory covers all redistributed code, binaries, and visual assets.
- **AC-D09-05:** No unsupported version is labeled supported solely because installation succeeded.

## Sources and related documents

**RESEARCH-RECORDED:** [VS Code publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [Arduino configuration](https://docs.arduino.cc/arduino-cli/configuration/), [CadQuery installation](https://cadquery.readthedocs.io/en/stable/installation.html), [Arduino Language Server](https://github.com/arduino/arduino-language-server), [OpenCode Windows guidance](https://opencode.ai/docs/windows-wsl). Revalidate release-specific statements during G0.

Related: [unknowns](unknowns-and-validation-spikes.md), [accounts](accounts-subscriptions-and-api-routing.md), [packaging](packaging-release-and-maintenance.md).
