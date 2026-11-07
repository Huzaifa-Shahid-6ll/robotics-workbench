# Workbench operator guide

A Windows-first VS Code extension and local companion for Arduino, agent-assisted source work, wiring, serial capture, experiments, and engineering handoffs. See the [latest UI changes](../ui-work/2026-11-07-ui-pass/README.md) and the [public verification scope](../verification/README.md).

Use the [installation and troubleshooting guide](personal-installation-and-troubleshooting.md)
for local VSIX installation, the local runtime, maintenance and recovery.

**Robotics: Export Diagnostic Bundle** opens a read-only local preview of version
observations, receipt summaries and storage health. Review it before selecting
**Save diagnostic bundle** and a new JSON file. Source, serial bytes, document
text, provider conversations, credentials and private paths are excluded by
default. Existing files are preserved. Historical versions do not assert current
tool readiness.

TASK-12 adds inspected packaging, strict release records and an isolated
maintenance drill. Release acceptance remains pending native UI/accessibility
evidence and verified vendor OS support. The local Windows test results and
unresolved gates are recorded separately; no Marketplace publication is needed.

TASK-11 adds **Robotics: Recovery Center**, **Robotics: Export Project Backup** and
**Robotics: Restore Project Backup**. Inspect retained receipts and raw captures
without replaying operations. Unknown uploads remain unknown after an explicit
stopped-uploader acknowledgement; any future upload still needs its exact target
and artifact. Interrupted captures retain verified raw prefixes and visible gaps.

Backups include ordinary engineering files, finalized evidence and a consistent
database snapshot. Save/reconcile dirty documents and finish active operations
first. Export and restore use independent empty directories, exclude private
credential/provider paths and reject recognizable credentials. After restoration,
close the old workbench owner, open the restored folder and select its restored
operational data directory. Historical device/firmware/wiring records do not become
current observations. Retained source review can explicitly rebind only when its
saved files match and editor buffers have no conflict. See [TASK-11](../tasks/TASK-11.md)
for checks and remaining release gates.

TASK-10 adds **Robotics: Open Schematic Handoff** and **Robotics: Open CAD Handoff**.
KiCad and CadQuery are optional, explicitly configured local tools. Set the machine
settings `roboticsWorkbench.kicadPath` and `roboticsWorkbench.cadPythonPath` to the
tested CLI and isolated Python interpreter, then reconnect the companion. The
optional `kicadSha256` setting pins an exact tested executable. No view installs
packages automatically. See [TASK-10](../tasks/TASK-10.md) for native compatibility
evidence, supported scope and remaining release checks.

Schematic generation uses reviewed `components/kicad.json` mappings and staged
native files. Native edits stay authoritative; export creates a new directory.
CAD assets live in `mechanical/assets.json` with ordinary scripts, parameter files
and an exact environment lock. Exports identify their script/input fingerprint,
millimeter units and validated artifact bytes. Unknown fit-critical dimensions
block production export; exploratory assumptions stay labeled. Existing viewers
open through an explicit handoff. Geometry checks do not certify physical fit.

Personal Windows-first VS Code extension and local Node companion. The complete
product remains defined by [00-START-HERE.md](../00-START-HERE.md). Implemented paths
cover ordinary Arduino projects, coordinated devices, both agent adapters,
wiring, documents, recordings/experiments, native KiCad/CAD handoffs and recovery.
The dedicated Uno checks observed exact-artifact upload, startup/counter bytes,
external contention, USB removal/reconnection and capture-process-loss recovery.
Scope and remaining checks are in [TASK-11](../tasks/TASK-11.md); these observations
do not establish wiring or sensor/actuator behavior or complete-release acceptance.
TASK-02 evidence is in [its task record](../tasks/TASK-02.md). Compatibility results are in
[TASK-00 completion](../verification/task-00-completion.json).

The project-bound companion validates v1 requests, manifest revisions and content
hashes, and serves scoped snapshots/operation lookups. Operational SQLite data
and immutable hashed artifacts stay outside project files. Full single-project
archive/restore preserves ordinary files and selected operational evidence;
multi-project database export is explicitly refused in this version. Snapshots
are bounded to 64 MiB/file and 256 MiB total; larger projects require streamed
ingestion. TASK-04 composes the Arduino and serial adapters through these same
project, job, artifact and device boundaries.

TASK-03 adds durable job admission/cancellation, bounded subprocess supervision
and one device/port lease coordinator. `device.status` and `operation.cancel`
use that same project-bound companion. Windows cancellation waits for the owned root and
tested process tree to terminate; arbitrary detached descendants are not an OS
sandbox. Batch wrappers are rejected rather than launched through a shell.

Observed test environment: Windows 10 Education x64 build 19045, VS Code 1.144.0,
Node 24.18.0, npm 11.16.0, Python 3.11.0. Reuse these installations. The companion
requires a detected local Node 24 runtime, minimum 24.18.0; native bindings are
never loaded into Electron. Other runtime/host versions remain unverified.

From this project root in PowerShell:

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run launch
```

The last command opens an Extension Development Host. Alternatively, open this
root in VS Code and press F5, selecting **Robotics Workbench**. In that window,
open the Robotics activity bar or run **Robotics: Check Tools**. Grant Workspace
Trust only for your own trusted project. The status changes to **companion ready**
after the validated handshake. Output distinguishes shell readiness from tools,
providers and devices. The companion
starts only on demand. Closing the host requests shutdown and observes exit.
A competing workbench owner is refused. Source browsing remains available in
Restricted Mode, with execution disabled.

If Node is not on the VS Code host's PATH, set the machine setting
`roboticsWorkbench.nodePath` to its existing absolute executable path. The
extension is restricted to local Windows x64 folders. Remote, WSL, containers
and web hosts are not supported by this increment.

In a trusted project folder, use **Robotics: Import Existing Sketch** to create
only a new `workbench.json` referencing the ordinary sketch. Existing `.ino`,
`.h` and `.cpp` files stay in place. Select a compiler FQBN separately from the
physical board. **Robotics: Compile** offers save-and-build, freezes source
hashes, records build inputs and publishes current diagnostics to Problems.
Dirty editor/provider conflicts stop the request and preserve both versions.
**Robotics: Upload Exact Artifact** requires an explicit current successful
build, observed device and artifact hash; saving or compiling never uploads.

The enabled adapter targets installed Arduino CLI **1.5.1**, with exact-artifact
upload limited to `arduino:avr:uno` on Arduino AVR **1.8.8**. It does not install
or upgrade dependencies. `sketch.yaml` profile-bearing sketches are preserved
and explicitly refused until a separate dependency-policy validation exists.
Set machine setting `roboticsWorkbench.arduinoPath` if discovery cannot find
the installed executable. Missing Arduino leaves ordinary editing and scoped
project reads available.

**Robotics: Record Raw Serial** requests an explicit baud and 1–3600 second capture
through the same device coordinator. Opening a port can reset Uno. Raw JSONL
retains exact bytes, host receive timestamps and gaps; output previews are
bounded to 64 KiB. Numeric parsers and plots are separate explicit telemetry derivations. An uploader success receipt does not verify physical behavior or wiring.

Provider tools retain a separate 1–60 second capture limit. Longer native user
recordings do not require reopening the serial port each minute.

**Robotics: Inspect Application Context** shows the bounded application snapshot.
**Robotics: Open Codex Terminal** supplies that snapshot, at most 24 KiB, to the
existing native Codex executable using literal argument arrays. Set machine
setting `roboticsWorkbench.codexPath` to the installed native `.exe` when needed.
The existing provider handles its own sign-in; the workbench does not copy
credentials or private provider history. TASK-05/TASK-06 provide normalized provider adapters and the shared agent panel;
see their task records for evidence and version limits. Operational storage defaults
to extension global storage; `roboticsWorkbench.dataRoot` may select another
absolute directory outside project source.

Real-host tests reuse the installed VS Code, with isolated profiles under this
project. `WORKBENCH_VSCODE_EXECUTABLE` may select an existing `Code.exe`:

```powershell
npm run test:host
```

Documentation validation and packaging use a separate local Python environment:

```powershell
python -m venv .venv-validation
.venv-validation/Scripts/python -m pip install -r scripts/requirements-validation.txt
.venv-validation/Scripts/python scripts/validate_pack.py --contracts --report artifacts/document-validation.json
npm run package
npm run test:packaged
```

`npm run package` builds and inspects
`artifacts/robotics-workbench-0.1.0.vsix`, its SHA-256, bundled license notices,
and an allowlisted archive inventory. `test:packaged` installs that exact VSIX
only under `.vscode-test`, byte-checks the installed bundle, and runs trusted and
restricted host tests against those installed assets. No Marketplace publication
or normal-profile extension installation occurs. Tests leave no companion running.

`npm ci --ignore-scripts` is intentional: all selected tools work from their
installed package files without dependency install hooks. There is one npm lockfile.
The dev-only vsce minimatch override pins 11.0.3 to resolve the observed advisory;
package/inspection tests validate that combination. No runtime dependency is
loaded from the checkout by the installed VSIX. The native serial runtime
(`@serialport/bindings-cpp` **13.0.1** and its dependencies) is copied under
`dist/vendor`, with exact file hashes in `dist/native-runtime.json` and bundled
licenses. Installed-host tests load that copy in the companion Node runtime
and reject an owned ordinary file as a serial port without accessing a board.
No Node executable is redistributed.

Read-only environment inventory and compile-only compatibility checks:

```powershell
npm run doctor
node scripts/compatibility/sqlite-probe.mjs
.venv-validation/Scripts/python scripts/compatibility/compile-probe.py --cli 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'
```

The Uno fixture is synthetic. This command never enumerates a board, opens a
serial port, uploads, installs a core or changes Arduino configuration. It does
not satisfy an existing-user-sketch or real-board acceptance gate. Provider
protocol probes are separate from the build/test workflow; their safe observed
summary and live-session outcomes are in the progress record.

TASK-00 additionally compiled a preserved copy of the installed Arduino Blink
example, tested both providers with existing OpenAI/ChatGPT sign-ins, and installed
an isolated VSIX to check native SQLite/serial-library loading. These are
compatibility spikes, not production hardware/provider implementations. No personal
Arduino sketch was found, and no physical board was accessed during TASK-00.

The native-library check is separately reproducible without a board:

```powershell
node scripts/compatibility/native-package.mjs
```

Live provider scripts are explicit opt-in because they submit tiny text-only
messages through existing accounts. They do not change global configuration:

```powershell
.venv-validation/Scripts/python scripts/compatibility/codex-lifecycle.py --executable 'C:/nvm4w/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe' --live
node scripts/compatibility/opencode-lifecycle.mjs --executable (Join-Path $env:USERPROFILE 'scoop/apps/opencode/current/opencode.exe') --model openai/gpt-6.1-sol --live
```

Omit `--live` to inspect safe route metadata without inference. A failed or expired
provider login requires that provider's normal sign-in; no other account or API
route is selected automatically. The OpenCode spike tests SDK and executable
1.18.32 together, in pure mode with external plugins disabled.

See [task progress](../tasks/TASK-00-01.md) and
[verification evidence](../verification/task-00-01.json) for actual checks, failures
fixed, limitations, gate dispositions and the next task.

`Robotics: Components & Wiring` opens the manifest-backed component table,
connections and canvas. Add unresolved instances until exact part identity is
known; preview changes before committing them. Layout saves independently in
`.workbench-layout.json`. Explicit code bindings navigate source without changing
firmware. Ask about selection prepares revision-bound agent context; Send remains
separate. Reported observations remain historical and become stale after design
changes. Rule results and diagram lines do not establish physical continuity or
electrical safety. Optional reviewed definitions belong in ordinary
`components/catalog.json`; changed facts require a new definition version.

`Robotics: Attach Project Document` associates an existing project-local PDF, text
or Markdown file in the ordinary manifest. `Robotics: Documents & Datasheets`
indexes saved bytes explicitly, displays an isolated original PDF page, and searches
retained text. Historical hashes/extractor versions/pages and text ranges remain
addressable after replacement or removal. Scanned text is not fabricated; the
original page remains available. Ask freezes the citation before a separate Send.
Open original saves an exact verified copy to a new filename. OCR, remote fetching
and automatic electrical fact promotion are outside this increment.

`Robotics: Start Arduino Language Service` reuses installed Arduino language server,
clangd and Arduino CLI for one chosen sketch/FQBN, including unsaved-buffer
diagnostics. Configure absolute machine paths when IDE discovery is insufficient.
`Robotics: Stop Arduino Language Service` closes its owned resources. No compiler,
core or library installation or upgrade is performed by language startup.

`Robotics: Telemetry & Experiments` opens retained recordings, explicit parser
profiles, plots, exact interval inputs and run comparison. `Robotics: Open
Telemetry Parser Profiles` edits ordinary telemetry/parsers.json. Live display
pause is separate from stopping capture; only finalized immutable intervals can
enter agent context. Configure procedures in experiments/procedures.json, retain
setup/parameters before starting a run, and record judgments explicitly against
evidence. Source/configuration changes remain visible; plots and uploader success
do not establish physical behavior. Experiment JSON exports preserve raw/parsed/
procedure/metric evidence; use project archives for complete source/firmware bytes.
