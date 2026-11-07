---
doc_id: D37
title: "CAD Python and 3D preview"
status: implementation-spec
updated: 2026-11-03
depends_on: [D09, D19, D20, D34]
requirement_ids: [REQ-HW-37-01]
---

# CAD Python and 3D preview

## Purpose and authority

**SPECIFIED — REQ-HW-37-01:** Use CadQuery as the initial Python CAD engine and reuse OCP CAD Viewer where its documented workflow is compatible. Preserve scripts and parameters as the source of truth. A preview mesh is disposable derived data. The workbench supports simple scripted parts and exports; it does not implement a general mechanical CAD editor, physical simulator, or manufacturability certification.

**SOURCE-VERIFIED:** Official CadQuery sources retrieved through Context7 on 2026-11-01 show headless geometry validity checks and STEP/STL export. Exact released API compatibility remains a Windows environment gate because documentation can describe repository `master`. Viewer integration below is RESEARCH-RECORDED and requires a public-interface spike before automation.

## Environment and invocation

Discover a project-selected Python interpreter and an isolated CAD environment. Do not install into arbitrary global Python or assume the newest interpreter has compatible OpenCascade wheels. Record Python, CadQuery, OCP, viewer, and relevant package versions after a simple real fixture succeeds. Installation is explicit, lazy, and configurable to a non-system drive. CAD absence must not block Arduino editing/building.

Each generation is a supervised child process with fixed workspace, interpreter, source snapshot, parameters, temporary output directory, timeout, and cancellation policy. Python is executable code: trusted workspace and tool-action policies apply. Process isolation alone is not a security sandbox. No run may silently install packages, launch hardware operations, or fetch assets because a generated script requested them.

The standard script contract is an application convention: scripts read a validated parameter JSON file and emit declared output artifacts into the supplied staging directory. The adapter documents arguments and environment separately from CadQuery APIs. Do not require arbitrary user scripts to expose private viewer internals.

## Model and parameter identity

```json
{
  "assetId": "99999999-9999-4999-8999-999999999999",
  "scriptRelativePath": "mechanical/bracket.py",
  "sourceSnapshotId": "33333333-3333-4333-8333-333333333333",
  "engine": "cadquery",
  "parameters": {
    "plateWidth": {"value": 50, "unit": "mm", "basis": "design-choice"},
    "holeSpacing": {"value": null, "unit": "mm", "basis": "unknown"},
    "clearance": {"value": 0.4, "unit": "mm", "basis": "proposed"}
  },
  "componentIds": ["22222222-2222-4222-8222-222222222222"],
  "dimensionEvidenceRefs": []
}
```

Unknown fit-critical dimensions block a claim of fit and production export for that declared purpose, but the user may request an exploratory preview using clearly labeled assumptions. Keep nominal geometry, manufacturing clearance, and measurement uncertainty separate. A photo-estimated dimension cannot become a manufacturer-specified value. Parameter changes invalidate generated artifacts even when script bytes are unchanged.

A generation fingerprint includes script and imported local-module hashes, parameter values/units, engine/environment lock, output settings, and source evidence dependencies. Script files remain usable outside the extension. Cache retrieval requires a complete matching fingerprint; unknown dynamic imports make the run non-reproducible and must be disclosed.

## Generation and preview contract

The minimal smoke fixture uses documented APIs:

```python
import cadquery as cq
result = cq.Workplane("XY").box(20, 10, 3)
assert result.val().isValid()
cq.exporters.export(result, "fixture.step")
cq.exporters.export(result, "fixture.stl")
```

This example is source-verified syntax, not an executed result. The implementation fixture must additionally check expected dimensions/volume and re-open exported artifacts. Use explicit units; STL has no reliable embedded unit contract, so its artifact metadata/export UI must state millimeters. STEP solid export and tessellated display quality are separate choices. Keep final mesh tolerance recorded and avoid excessive tessellation on the user's integrated graphics.

OCP CAD Viewer can display CadQuery objects through its documented Python workflow. First support the visible task/user workflow; invoke extension commands only if publicly documented and tested. If a stable programmatic bridge is unavailable, provide an explicit viewer handoff rather than claim seamless private-protocol integration. Do not ship a second renderer just to hide this gate.

## Validation, failure, and recovery

Require nonempty declared outputs, geometric validity where applicable, expected bounding dimensions with tolerances, and successful import into the selected independent consumer. These checks do not establish strength, material suitability, printability, or physical fit. Record their scope.

Invalid boolean/fillet geometry, missing dependency, timeout, cancelled process, disk full, and viewer failure are distinct outcomes. Preserve the last successful artifact and label it stale when regeneration fails. Promote staged files atomically where possible only after validation; never replace a good model with a zero-byte export. Viewer failure must not change a valid generation receipt into a false geometry failure; record separate preview status.

## TASK-10 implementation boundary — 2026-11-03

The version 1 ordinary-file convention is `mechanical/assets.json`, with separate
Python source, declared local-module paths, parameter JSON and an exact isolated
environment lock. The checked-in synthetic box fixture documents the complete
shape in [the fixture guide](../packages/test-fixtures/cad/README.md). It models
design choices only. Assets use UUID identities; ordinary files remain editable
outside the extension. The service never rewrites source or original parameters.

`cad.snapshot` reports saved input fingerprints, parameter basis/units, issues,
latest receipts, retained good receipts and staleness. `cad.generate` requires
the current manifest revision and expected input fingerprint, returns a queued
`cad-generate` receipt, and uses the existing heavy-job queue and process-tree
supervisor. The native host checks dirty buffers for source, modules, parameter,
lock and evidence files before admission. A queued job independently rechecks
saved inputs. Missing CAD dependencies leave ordinary Arduino work available.

The selected interpreter must be an existing venv or conda environment. The
runner checks the exact Python patch version and complete normalized installed
distribution inventory against `environment.lock.json`. No installation,
dependency upgrade or asset fetch is an adapter side effect. The measured Windows
cold import exceeded the proposed 120-second watchdog; TASK-10 uses a bounded
300-second CAD deadline. Adapter configuration can override this for tests.
This is executable trusted Python, not a sandbox against arbitrary Python code.

Scripts receive `--parameters <validated-json>` and `--output-dir <staging-dir>`.
They expose a CadQuery Shape/Workplane named `result`, and emit nonempty
`model.step` and binary `model.stl`. Input files are read through existing stable
source-snapshot/path guards (4 MiB per input, 32 MiB total); declared outputs are
bounded to 64 MiB each. The runner checks source solid validity, expected bounding
dimensions and volume, independently imports STEP and STL through their public
readers, and checks reopened bounds and signed STL triangle volume against the
declared tolerances. Tessellation settings are fingerprinted declarations that
the ordinary script must honor; this is not a mesh-deviation certification.
Only validated output bytes enter immutable artifact storage. Source bytes,
effective/original parameters, environment and validation results are retained
as a separate provenance artifact. Before queue admission, the canonical source
snapshot ID resolves to an immutable `cad-source` inventory in `source_snapshots`,
with exact source-file artifact references, revision and original/effective
parameters. Failed and cancelled runs retain that frozen inventory too. Failure
staging/logs remain operation-scoped.

The input fingerprint covers the asset declaration, selected interpreter path,
source/local-module bytes, parameter values/units/basis, environment-lock bytes,
output settings and hash-checked evidence dependencies. A generation fingerprint
also binds preview/production mode and explicit exploratory assumptions. There is
no output cache. Declared dependency completeness remains a trusted source
contract; common dynamic import/exec forms are conservatively detected and
disclosed as non-reproducible. This scan does not prove arbitrary Python has no
other external inputs. Non-reproducible runs cannot be production-exported.

Unknown values remain `null` with `unknown` basis. Exploratory generation requires
an explicit assumption for every unknown input, retains original unknowns and
records effective values as proposed. Measured/manufacturer values require
declared hash-checked evidence files; validation verifies those bytes, not the
truth of a claimed measurement. `cad.export` permits only the latest successful,
current, reproducible production generation. Failed, cancelled or timed-out
attempts preserve the last good bytes and make them visibly stale. An accepted
manifest revision also makes prior-revision geometry historical, even when CAD
input bytes and their fingerprint are unchanged; production export requires the
current manifest revision. Historical viewer handoff remains available.

`cad.viewer` creates a guarded Python handoff referencing the exact retained STEP
hash, using public `cadquery.importers.importStep` and `ocp_vscode.show`. Native
VS Code opens that script and displays the public viewer instructions; no private
viewer command or second renderer is used. An externally edited handoff is
preserved and reported as a conflict. Viewer status remains `handoff-required`;
opening a script does not assert viewer display success or change geometry
validation. The current public OCP CAD Viewer README was checked on 2026-11-03:
install its extension and Microsoft's Python extension explicitly, select the
correct interpreter, open the script and use Run Without Debugging (`Ctrl-F5`).
See [the public workflow](https://github.com/bernhard-42/vscode-ocp-cad-viewer).

Executed software/native checks and any failed initial probes are retained in
the [TASK-10 record](../tasks/TASK-10.md). Fake adapter tests establish software
preservation and validation behavior; they never establish physical fit.

## Acceptance criteria

- **AC-D37-01:** A pinned isolated Windows environment generates the fixture and STEP/STL reopen independently.
- **AC-D37-02:** Parameter, imported-module, or engine changes invalidate prior outputs.
- **AC-D37-03:** Missing dimensions remain unknown throughout agent context and export review.
- **AC-D37-04:** Timeout/invalid geometry preserves previous artifacts with visible staleness.
- **AC-D37-05:** Viewer integration uses supported interfaces or an explicit handoff; no private command dependency is silently assumed.

## Sources and related documents

- [CadQuery shape API source](https://github.com/cadquery/cadquery/blob/master/cadquery/occ_impl/shapes.py), [quickstart source](https://github.com/cadquery/cadquery/blob/master/doc/quickstart.rst) — SOURCE-VERIFIED via Context7, 2026-11-01.
- [CadQuery installation](https://cadquery.readthedocs.io/en/latest/installation.html), [OCP CAD Viewer](https://github.com/bernhard-42/vscode-ocp-cad-viewer) — RESEARCH-RECORDED, 2026-10-31.
- [Component facts](components-and-parts-catalog.md), [security](security-and-data-boundaries.md), [dependencies](dependencies-and-compatibility.md).
