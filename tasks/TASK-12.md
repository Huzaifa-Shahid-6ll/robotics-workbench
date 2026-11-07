# TASK-12 — Personal release preparation

## Resumed acceptance — 2026-11-06

The user authorized completing TASK-11/TASK-12 with desktop and MCP tools.
Root owns this resumed run under D09/D48/D49/D50 and the requirements below.
Expected changes are task/verification records, plus a minimal fix only if a
current check exposes a defect. Planned checks: current installed candidate,
native UI acceptance, read-only OS/runtime vendor-support assessment, evidence
integrity and release validation. Existing historical observations keep their
original scope; neither broad authorization nor automation is an acceptance pass.

### Resumed result

The patched candidate SHA-256 is
`e6d1d710e3491a2efe9792d95990b0775ad119cf71f7761aa54f26b82042cfe8`.
Its package contains 295 allowed entries and passed the seven negative inspection
fixtures. Trusted/restricted installed-host checks passed with companion exit
observed. Maintenance run `1f5c21ec-f15e-4627-bcc9-d24736de1c9b` passed actual isolated
install, synthetic same-code rollback, update, newer-schema refusal, migration
failure/backup checks and uninstall preservation against this exact candidate.
The earlier interrupted maintenance record contains only NUL bytes and is not
accepted as evidence. Its isolated files remain preserved; the fresh drill used
a new directory. The previous VSIX and task reports are retained separately.

Current primary-source review still does not establish vendor support for Windows
10 Education 22H2/build 19045. Read-only licensing inventory found twelve Client-ESU
entries and none with licensed status; this does not establish every possible
enrollment mechanism or a supported exception. No OS/license/runtime change was
made. TASK-11's native visual/full-keyboard/screen-reader obligations and the
supported-platform gate remain open. TASK-12 remains blocked and no G6 acceptance
or public publication is claimed. The resumed evidence folder records the exact
commands, hashes, failed attempts, narrow native observations and remaining gates.

Started 2026-11-04 on `codex/task-12-release`, from TASK-11 implementation commit
`f65448d`. Integration owner: root. Status: independent implementation/preparation;
complete-release acceptance is blocked by the manual gates retained in TASK-11.
The user requested stopping the Narrator check. That is not a fabricated pass or
a waiver of G6. No Marketplace publication or cloud deployment is authorized.

Owning documents: D09, D48, D49 and D50; D02 governs implementation, D14/D18/D19
retain canonical IDs, version-1 boundaries, authority and operation meanings.
Requirements: REQ-ARCH-49, REQ-ARCH-48, REQ-PROD-01, REQ-PROD-06,
REQ-ARCH-05 and REQ-UX-06, plus D49/D48/D50 task acceptance assertions.
The supporting diagnostic boundary also covers REQ-ARCH-01, REQ-ARCH-02,
REQ-ARCH-03 and REQ-AGENT-29.

The three implementation agents own separate work:

- `task12_release`: release-record generation/validation, recorded compatibility
  and dependency/license matrix support, and focused negative-evidence tests.
- `task12_diagnostics`: private-by-default diagnostic DTO/service and its tests.
  Root integrates protocol, main process and native command composition.
- `task12_maintenance`: isolated install/update/rollback/uninstall/data-preservation
  drill, its bounded fixtures, and the installation/troubleshooting guide.

All agents read their D01–D50 ranges plus governing cross-contracts. Current vendor
interfaces use Context7. Agents are not alone and may not redefine shared IDs,
states or authorities. Root serializes actual companion/native/provider sessions.

Expected paths: scripts/release, docs, verification and private package artifacts.
D49's missing diagnostic-export behavior additionally requires minimal companion
and native-extension composition, contracts and matching tests; this supporting
scope does not introduce another authority or hardware path. Native host UI and
existing recovery/document primitives are preferred over a new custom view.

Verification scope: strict release-manifest rejection
of missing mandatory/incorrect-class/corrupt evidence; exact VSIX inspection and
checksums; actual clean-profile install and maintenance preservation; real SQLite
migration-failure/newer-schema protections; default diagnostic privacy and failure
paths; type/boundary checks and affected tests; installed trusted/restricted host.
There is no previously shipped release. Any synthetic version fixture used to
exercise version changes must be identified, with no claim of historical-version
or cross-version data compatibility beyond what actually ran.

Only reversible, independent release work proceeds. An accepted release record,
final G6 sign-off and any work depending on missing manual evidence remain gated.
Task status and every check must distinguish preparation, software, actual host,
physical hardware, user observations and unverified acceptance.

## Implementation and executed checks — 2026-11-06

The three agents completed release-record tooling, private diagnostic export and
maintenance tooling. Root integrated the command, strict protocol boundary,
native read-only preview, package inspection, tests and documentation. No new
dependency, provider transport, hardware operation or publication was introduced.

The full software run `4c0a999f-d993-4567-8f1c-57b7c888f1d4` passed contract
validation, type/boundary/evidence checks, 433 tests and both controller audits.
The interrupted wrapper retained those three completed stages. Its remaining
package and installed-host stages were executed separately on November 6.
The first packaging command failed because C: was full; the retained retry used
G: for npm cache and temporary files and passed without deleting user files.

The exact candidate VSIX SHA-256 is
`115bbffc52aaaa20eedc29b728e70c378f5d76d700b1bc56c1dd70e3f85b4129`.
Inspection passed 295 allowed entries plus seven negative fixtures for ZIP bounds,
private payload paths and missing runtime files. Installed trusted/restricted
hosts passed and companion exit was observed. Native diagnostics used the actual
installed controller, immutable preview and real companion export; consent and
file-picker callbacks were fixtures, so this does not establish manual dialog,
appearance, keyboard or spoken-output acceptance.

Maintenance run `31c8ab30-17a5-4b53-be26-2a7e1f60bcdf` passed actual isolated
VS Code CLI install, synthetic version rollback, update and uninstall. Source,
receipts and artifact bytes survived. Real SQLite migration failure retained and
restored its backup; an installed older-version fixture refused a newer schema
without modifying its files. The synthetic 0.0.0 fixture changes only version
manifests, not application code. It proves no historical release compatibility.
The copied conventional profile storage fixture does not establish actual
ExtensionContext default-path resolution. No physical device was accessed.

Dependency restore `3bcf07cf-ded6-4f9f-af1d-bde7c1defcef` passed `npm ci` against
copied workspace manifests and the unchanged lockfile in an isolated G: directory.
Lifecycle scripts were disabled; this verifies dependency restoration, not a
fresh-source build. The working checkout's installed dependencies were preserved.
Release-validator tests include rejection of missing/forged/corrupt evidence and
unverified vendor support. The release record must remain blocked while any
mandatory evidence is incomplete; generating it is not approval to publish.

The machine remains Windows 10 Education build 19045. Current vendor support,
including ESU applicability, is unverified. Further Narrator participation was
stopped at the user's request after a sound without spoken values. TASK-11 manual
native UI/keyboard/zoom/speech obligations remain incomplete. G6 and complete
release acceptance remain blocked; no requirement or acceptance gate was waived.

The structured completion record is `verification/task-12.json`; its check
references retain original evidence classes, dates, source identities and hashes.
Historical TASK-11 hardware/provider evidence is separate from TASK-12 software
and installed maintenance. Exact changed paths and remaining gates are recorded
there. Private package bytes stay under `artifacts`; no Marketplace or cloud
publication ran.

The release identity uses the last implementation commit, excluding operational
verification/artifact commits. A focused real-Git fixture checks that adding
evidence preserves that identity, while source edits change its digest and source
commits change its revision. Exact VSIX/runtime identities remain mandatory.
