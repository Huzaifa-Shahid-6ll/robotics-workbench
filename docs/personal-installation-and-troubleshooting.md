# Private installation and maintenance

These instructions install the Windows x64 candidate into desktop VS Code. A
successful install establishes distribution behavior; it does not accept the
complete personal release. The [TASK-12 record](../tasks/TASK-12.md) and supplied
release evidence identify remaining gates. Native visual, keyboard, zoom and
screen-reader acceptance retained by TASK-11 is still incomplete.

## Check the supplied candidate

Use the exact VSIX, SHA-256 checksum, dependency/license inventory and compatibility
matrix supplied together. Compare the package hash before installing:

```powershell
Get-FileHash .\robotics-workbench-0.1.0.vsix -Algorithm SHA256
```

A matching hash establishes byte identity, not the trustworthiness of its source.
No Marketplace account or publication is needed. Do not install the synthetic
`0.0.0` maintenance fixture as an application release.

The recorded local combination uses VS Code 1.144.0 x64 and a separately detected
local Node 24.18.0 runtime. The VSIX contains the companion and allowed Windows
native dependencies; it does not redistribute Node or load those native modules
inside Electron. Use the exact tested matrix rather than assuming a newer Node,
editor or provider is compatible. Optional KiCad/CAD tools have their own tested
combinations in [D09](dependencies-and-compatibility.md).

Local execution on Windows 10 Education build 19045 does not establish current
vendor OS support. [VS Code's requirements](https://code.visualstudio.com/docs/supporting/requirements)
refer to supported Windows clients; Microsoft's [servicing table](https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client)
places Windows 10 22H2/build 19045 beyond ordinary servicing on 2025-10-14.
[Node 24.18.0's platform policy](https://github.com/nodejs/node/blob/v24.18.0/BUILDING.md)
also excludes vendor-end-of-life platforms despite its Windows 10 minimum.
ESU eligibility and the vendors' extended-support policy applicability were not
verified. That compatibility gate remains open; the installer changes no OS or
runtime to hide it.

## Install and open ordinary source

In VS Code, use **Extensions: Install from VSIX…**, select the inspected package,
then reload if requested. The equivalent documented command is:

```powershell
code --install-extension .\robotics-workbench-0.1.0.vsix
```

Open the existing local sketch folder. Ordinary `.ino`, `.h` and `.cpp` files stay
editable without an agent login or connected board. Use **Robotics: Import
Existing Sketch** when the folder needs workbench metadata; this does not convert
the sketch. Workspace Trust is required before executing tools. Remote SSH, WSL,
container and browser workspaces have an explicit unsupported device boundary.

Open native VS Code user settings for machine-specific paths. Configure only
tools actually installed:

| Setting | Purpose |
|---|---|
| `roboticsWorkbench.nodePath` | Absolute local Node 24 executable; empty uses host discovery |
| `roboticsWorkbench.dataRoot` | Absolute operational data directory outside project source |
| `roboticsWorkbench.arduinoPath` | Installed Arduino CLI; empty checks discovery/Arduino IDE |
| `roboticsWorkbench.codexPath`, `roboticsWorkbench.opencodePath` | Native provider executable paths |
| `roboticsWorkbench.arduinoLanguageServerPath`, `roboticsWorkbench.clangdPath` | Optional language tools |
| `roboticsWorkbench.arduinoConfigPath` | Existing CLI configuration for the language service |
| `roboticsWorkbench.kicadPath`, `roboticsWorkbench.kicadSha256` | Optional tested KiCad CLI and exact fingerprint |
| `roboticsWorkbench.cadPythonPath` | Optional Python executable in the selected isolated CAD environment |

The default data location is extension global storage. For large recordings or a
small system drive, choose a data root on a drive with space. Changing a setting
does not migrate existing history: stop affected jobs and close the owner, export
a project backup, restore to independent empty roots, then reopen and verify the
restored evidence. Retain the old copy until that succeeds. See [storage and
migrations](storage-and-migrations.md).

Use **Robotics: Check Tools** to observe readiness. Executable detection,
authentication, task completion, compiler target and physical device identity are
separate facts. Missing KiCad/CAD tools disable those features without blocking
ordinary editing. No check automatically upgrades a core, library, runtime or
provider. Select a compiler target when needed; **Robotics: Select Observed
Device** separately selects a current device observation. Compile and upload are
distinct commands. A successful upload is not a physical-behavior result.

## Update, roll back, or uninstall

Before an update, finish or reconcile jobs, stop capture, close workbench owners
and retain a verified project backup. Install the inspected new VSIX and reopen
the same project/data only after checking the version matrix. A schema-changing
startup retains a pre-upgrade snapshot before its transaction. If it fails,
preserve the original directory and snapshot; do not delete the database.

To roll back application code, install the retained known package using the
documented local VSIX operation. A database with a newer unsupported schema is
refused rather than downgraded. Selecting an older backup is a separate explicit
restore to new directories; changing application code never restores firmware or
physical wiring. There is no previously shipped workbench release yet, so the
maintenance drill's same-code version fixture establishes CLI version mechanics
only. It does not establish compatibility with a historical application/schema.

Uninstall through the Extensions view or:

```powershell
code --uninstall-extension local-workbench.robotics-workbench
```

Uninstall leaves ordinary projects and operational evidence in their existing
locations. There is no automatic data purge or provider-credential cleanup. Keep
those directories and backups until their intended retention is decided.

## Export diagnostics locally

Run **Robotics: Export Diagnostic Bundle** from the Command Palette, Robotics
tree or Recovery Center. It opens a read-only sanitized JSON preview. Review it,
then choose **Save diagnostic bundle** and a new JSON destination outside project
and data roots. The exact preview hash and revision are checked again before
creation; a changed preview or existing destination is refused.

The default bundle includes bounded operational summaries, storage health and
observed version information with its applicability. It excludes source, raw
serial bytes, document text, provider conversations, credentials, private paths
and free-form log prose. Historical tool versions do not establish current tool
readiness. There is no private-payload opt-in in this implementation, no automatic
collection and no upload/sharing action. Save the local bundle only when requested.

## Troubleshooting

| Symptom | Preserve and inspect | Next action |
|---|---|---|
| Executable missing or version unknown | Source and retained history remain available | Check the absolute machine setting and **Check Tools**. Resolve only that feature's dependency; [D09](dependencies-and-compatibility.md) |
| Native module/ABI load failure | Keep the inspected VSIX, runtime version and diagnostic bundle | Use the declared external Node runtime and matching Windows x64 package. Do not load companion binaries inside Electron; [D49](packaging-release-and-maintenance.md) |
| Second workbench owner | Keep both projects and operation IDs | Finish/reconcile and close the first owner before reconnecting. No concurrent owner sharing is implemented; [D19](jobs-and-process-supervision.md) |
| COM port busy outside the workbench | Keep the current device observation and retained receipt | Close the identified external monitor if appropriate, refresh and explicitly select the device again. A workbench reservation cannot control other programs; [D32](device-discovery-and-upload.md) |
| Provider authentication or quota failure | Keep source, session identity and application-owned handoff | Use the provider's supported sign-in/account flow. Do not switch accounts, endpoints or billing routes as a hidden fallback; [D25](accounts-subscriptions-and-api-routing.md) |
| Search/index corruption | Retain originals, document hashes and citations | Rebuild only the derived index. Missing original artifacts need recovery, not fabricated replacements; [D38](datasheet-and-document-ingestion.md) |
| Full disk or partial recording | Keep finalized bytes, partial segments and gap metadata | Free space outside retained evidence or select a verified data location; start a new capture deliberately after recovery; [D33](serial-monitor-and-telemetry.md) |
| Interrupted migration/newer schema | Keep database, pre-upgrade snapshot and exact application versions | Select the matching application or explicitly restore the verified backup to new roots. Never delete data to force startup; [D16](storage-and-migrations.md) |
| Interrupted upload/unknown outcome | Preserve exact target, artifact and immutable unknown receipt | Inspect **Robotics: Recovery Center** and use its operation-specific reconciliation. No generic replay; [D46](journeys-states-and-recovery.md) |

## Developer maintenance check

These commands require the development checkout; end users installing the VSIX do
not need npm, a compiler or repository test fixtures.

```powershell
node scripts/release/maintenance-drill.mjs --self-test
node scripts/release/maintenance-drill.mjs --execute --vsix artifacts/robotics-workbench-0.1.0.vsix
```

The self-check uses real SQLite with explicitly synthetic records and synthetic
ZIPs; it launches no Code process. The execution mode first requires the exact
currently inspected VSIX. Run it only after other native/companion sessions stop.
It creates a unique `artifacts/task12-maintenance/<runId>` profile, extension
directory, project, data and temporary root. It installs the candidate, tests the
manifest-only version rollback/update, probes the installed companion's core open
and newer-schema refusal, uninstalls, and compares preserved source/data/artifact
hashes. It retains every log and failed run; it touches no main user profile or
provider account. CLI installation is separate from installed extension-host and
manual UI tests. The final release record must retain those evidence classes.

The preservation check covers configured external data and a closed store copied
into the conventional isolated-profile global-storage location. That second probe
tests whether maintenance removes those bytes; it does not claim to observe the
extension host's actual `ExtensionContext` path resolution.

Source-verified on 2026-11-04 through Context7: [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line)
and [local VSIX installation](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace).
