---
doc_id: D31
title: "Arduino toolchain integration"
status: implementation-spec
updated: 2026-11-02
depends_on: [D09, D13, D15, D19]
requirement_ids: [REQ-HW-31-01]
---

# Arduino toolchain integration

## Purpose and authority

**SPECIFIED — REQ-HW-31-01:** The workbench MUST compile ordinary Arduino sketches through the installed Arduino CLI and preserve the board platform's compiler recipes. It MUST NOT require replacement firmware, silently convert a sketch to another build system, or introduce a mandatory runtime library. D31 owns compilation and dependency behavior; [D32](device-discovery-and-upload.md) owns uploading. These are implementation requirements, not completed integrations.

**SOURCE-VERIFIED:** Arduino CLI exposes compile output paths, FQBN selection, library options, and a separate upload command. Context7 retrieved official Arduino repository documentation on 2026-11-01. Its `master` source may exceed the user's installed release; only tested capabilities enter the enabled adapter.

## Import and tool discovery

Resolve the executable from an explicit user setting first, then PATH. Record its absolute path and version; do not execute similarly named workspace files automatically. Probe help/version without modifying the installation. Read existing configuration and record the resolved Arduino directories. Missing CLI disables build/upload with an actionable explanation, not editing or file access.

The sketch folder and matching primary `.ino` file MUST remain valid outside the extension. Import is read-only until the user requests a change. Establish a baseline build with existing cores and libraries before suggesting a `sketch.yaml` profile or upgrade. A profile can change dependency resolution, so adopting one requires a reviewable change and another baseline compile. Dependency installation MUST be explicit, use a serialized toolchain-mutation queue, and record package source/version; never perform surprise downloads during ordinary import.

## Compilation contract

The application adapter accepts this semantic request; it is not an Arduino API type:

```ts
type CompileRequest = {
  projectId: string;
  expectedProjectRevision: number;
  sourceSnapshotId: string;
  sketchRelativePath: string;
  fqbn: string;
  boardOptions: Record<string, string>;
  profileName?: string;
  warnings: 'none' | 'default' | 'more' | 'all';
};
```

Before execution, reconcile dirty editor buffers and external-agent writes. Default behavior is to offer save-and-build or cancel; do not silently compile saved bytes while displaying newer unsaved code. Resolve paths under the allowed workspace and materialize a consistent source snapshot while retaining the Arduino sketch-folder convention. Capture local library content identity as well as package versions. Reject a manifest revision conflict rather than building against silently changed intended hardware.

A verified command pattern, with illustrative paths, is:

```text
arduino-cli compile --fqbn arduino:avr:uno --output-dir <new-operation-output-directory> <sketch-directory>
```

The process runner MUST pass an executable and argument array, not execute this text through a shell. The version adapter determines supported JSON/diagnostic flags. Do not adopt hidden flags or parse human progress text as a stable protocol. Keep stdout, stderr, exit code, and parser version even when structured output is available. Compile does not acquire a serial lease and MUST NOT stop monitoring.

## Artifact and diagnostic identity

A successful process MUST also produce expected nonempty artifacts. Copy them into immutable artifact storage and calculate SHA256. Record sourceSnapshotId, manifest revision, CLI version, FQBN/options, platform/core/compiler identities, resolved library versions or hashes, flags, output formats, and binary hashes. The fingerprint is the complete resolved build input, not just `.ino` contents. Unknown inputs make the build non-reproducible, not unusable; state that limitation explicitly.

Diagnostics reference sourceSnapshotId and original source locations after preprocessing mapping where supported. Outdated diagnostics remain inspectable but must be visibly stale after edits. Missing mappings must not invent line numbers. Preserve the previous successful build as history, but never silently substitute it after a failed compile.

## Errors, recovery, and limits

Missing dependency, invalid target, compiler failure, permission denial, disk full, malformed CLI output, and cancellation need distinct error codes and original diagnostics. Dependency repair is a separate action; no automatic major upgrades. A terminated compiler yields `cancelled` only when termination is confirmed; ambiguous process survival follows D19 reconciliation. Incomplete output directories remain quarantined and cannot be selected for upload. Cache deletion is safe only for derived files owned by the application.

**VALIDATION-GATE:** Pin the exact CLI/core/compiler/library combination after compiling a real existing Uno sketch on Windows. Test paths with spaces/non-ASCII characters and offline operation with installed dependencies. Published documentation is not a compatibility result.

## TASK-04 implementation scope — 2026-11-02

**IMPLEMENTED:** [ArduinoAdapter](../packages/adapters/arduino/src/index.ts)
accepts immutable saved-source snapshots, materializes the conventional sketch
folder/primary filename, probes effective configuration and expanded build
properties, and invokes compile with argument arrays. The enabled version is
Arduino CLI 1.5.1; other versions fail with an explicit compatibility error.
The recorded identity includes executable SHA256, configuration, core versions,
help hashes, expanded properties, compiler/platform/library content trees,
source snapshot and exact output hashes. `assertCurrent` rechecks these inputs
before upload. Diagnostics retain their source snapshot and map only supported
source locations; unavailable mappings use null locations rather than invented
line numbers. Raw tool logs remain retained with successful or failed evidence.

The native [host commands](../apps/extension/src/extension.ts) create only a new
manifest when importing an existing sketch. Save-and-build checks dirty editor
baselines, external disk hashes and document versions. Source edits clear active
Problems applicability; retained historical diagnostics remain queryable. A
failed build cannot automatically select an older upload artifact.

No core/library installation or upgrade is part of compile. A sketch containing
`sketch.yaml` is explicitly refused before compiler launch because profile
resolution can install dependencies; the file and original sketch are preserved.
Exact-artifact upload is currently enabled only for `arduino:avr:uno` with the
installed Arduino AVR 1.8.8 core. Successful compilation for another target does
not enable its upload path. Task evidence, including remaining real-board and
existing-sketch checks, belongs to [TASK-04](../tasks/TASK-04.md). The dedicated
Uno smoke run observed a deliberately invalid compile with source-linked
diagnostics and no upload artifact, then compiled and uploaded the identified
probe artifact. This does not establish a complete release or sensor behavior.

Current vendor interfaces were checked through Context7 against official
Arduino CLI documentation and installed CLI help. The local implementation
pins the tested combination rather than treating current repository docs as an
installed-version guarantee.

## Acceptance criteria

TASK-04 also supplied the unchanged staged `.ino` directly to installed Arduino
IDE 2.3.10 and observed a responding `WorkbenchProbe` native window. Source SHA
matched the compiled fixture. This verifies native-file opening, with no IDE
compile/upload requested. The earlier Computer Use capture/input failure is
retained separately; no screenshot verification is claimed.

- **AC-D31-01:** Import and baseline compile leave every source-file hash unchanged and the sketch still opens in Arduino IDE.
- **AC-D31-02:** Dirty buffers cannot be omitted silently; source edits after build mark diagnostics/artifacts stale.
- **AC-D31-03:** Failed compilation cannot trigger upload or substitute an earlier binary.
- **AC-D31-04:** Changed board options or locally edited library contents change the build identity.
- **AC-D31-05:** Missing CLI/network/dependency and disk-full fixtures produce actionable errors without corrupting prior artifacts.

## Sources and related documents

- [Arduino compile reference](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_compile) — SOURCE-VERIFIED through official repository Context7 retrieval, 2026-11-01.
- [Arduino sketch specification](https://docs.arduino.cc/arduino-cli/sketch-specification) and [project profiles](https://docs.arduino.cc/arduino-cli/sketch-project-file) — RESEARCH-RECORDED, 2026-10-31.
- [Firmware preservation](project-format-and-firmware-preservation.md), [job supervision](jobs-and-process-supervision.md), [device upload](device-discovery-and-upload.md).

## TASK-08 language-service integration — 2026-11-03

Robotics: Start Arduino Language Service starts the existing installed Arduino
language server and clangd for one explicit sketch and FQBN. Machine settings
select absolute executables/configuration; the initial discovery also supports the
Arduino IDE installation. The external tools remain user-installed and are not
bundled or upgraded. vscode-languageclient 9.0.1 handles the public LSP boundary.
Unsaved documents synchronize through LSP; compiler snapshots, build receipts and
upload remain separate operations. Stopping/deactivation closes owned language
resources. Missing tools disable this command without disabling source editing.

Official Microsoft language-client API documentation was retrieved through
Context7. Arduino's official language-server README and installed help define
the launch flags because Context7 did not provide an exact language-server corpus.
Native compatibility observations belong to verification/evidence/task-08/language
and the TASK-08 completion record; executable detection alone is not a pass.
