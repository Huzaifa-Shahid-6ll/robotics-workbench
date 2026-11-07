# TASK-00 continuation — compatibility completion

Started 2026-11-01 on `implement/task-00-completion` from `8616768`.
Working tree was clean. Owner: this session; no delegates.

Owning documents: D09, D10, D23, D24, D25, D31, D49 and D50.
Requirements: REQ-PROD-01, REQ-ARCH-05, REQ-ARCH-49, REQ-AGENT-01,
REQ-AGENT-02. Acceptance: AC-D10-01 through AC-D10-04.

Scope: finish native provider session/interrupt/reconnect spikes using existing
supported authentication; assess an exact OpenCode SDK/server pair; package an
isolated native SQLite/SerialPort compatibility fixture outside the developer
module search path; find an existing user sketch and compile a preserved copy.
No provider adapter/UI implementation, global upgrade, CAD/EDA dependency,
board enumeration/open, firmware upload, bootloader action or original source edit.

Expected files: scripts/compatibility, packages/test-fixtures/compatibility,
root dev dependency lock/configuration, D09, task/progress records and verification
evidence. Existing callers: cheap provider/compile probes and `scripts/verify.mjs`
must remain usable without triggering model turns. Live checks get separate commands.
The production extension gains no hardware command or native dependency.

Checks: documented vendor schemas/API shapes; bounded synthetic provider messages,
observed completion/cancellation and reconnect without duplicate prompt; inherited
provider route with no credential extraction or automatic account/billing fallback;
packaged native DB operations and safe serial failure against an owned ordinary
file, never a physical device path; original/copy source hashes; relevant software,
contract and packaging regressions. All results/gates remain explicit until run.

The user authorized searching their computer for an existing Arduino program.
External folders are read-only; copies, builds and evidence stay under this root.

Observed results so far:
- Codex CLI 0.160.1 / configured gpt-6.1-sol / existing ChatGPT login: real
  text completion, interrupt after observed turn/started, process restart and
  thread/resume passed. Initial interrupt raced startup; its failure was retained.
- OpenCode executable and SDK both 1.18.32: connected provider metadata and
  authenticated server access pass. The selected existing OpenAI OAuth route
  failed before returning text: `UnknownError: Token refresh failed: 401`.
  Reconciled that exact failed session via GET; no duplicate prompt or account
  fallback was submitted. Provider-controlled reauthentication is required.
- Installed isolated native VSIX: SQLite 3.53.1 durable reopen/transaction rollback,
  SerialPort bindings-cpp 13.0.1 load and owned-ordinary-file rejection pass under
  Node 24.18.0 (modules ABI 137 / N-API 10). Runtime cache assertions prove every
  nonbuiltin dependency loaded inside the installed fixture, not the checkout.
- No personal sketch found in the searched user/data-drive locations. Compiled a
  preserved copy of Arduino IDE's pre-existing public Blink example for the Uno
  compiler target. Original and copied source hashes match; original untouched.
  This is an installed example, not user-authored firmware or physical validation.

The user completed normal OpenCode reauthentication. The same explicit
`openai/gpt-6.1-sol` route then passed: text completion, observed busy state,
abort with persisted MessageAbortedError, reconnect to the same session with
exactly two user messages, and a fresh event stream. No API-key fallback occurred.

Final status: TASK-00 done for the bounded compatibility packet after final checks
and review. VG-01/02/03/05/07 pass within the recorded scopes. VG-04 remains
conditional/not-run; VG-06 and all physical portions of VG-14 remain not-run.
G0's tiny packaged shell, provider feasibility and installed reference-sketch
compile are established; this does not pass G1 or the complete release.
Next task: TASK-02 (domain contracts and persistence), already ready.

Self-review checked: exact installed executable/schema/SDK versions; real terminal
events and persisted cancellation; no duplicate resubmission on reconnect; fresh
installed native artifact instead of development fallback; original file hashes;
scope of existing example versus user-authored source; no board handles; retained
failed probes and explicit provider-controlled sign-in. No production adapter,
uploader, serial monitor, SQLite repository or hardware capability was added.

The machine-readable completion record supplies actual commands/results, changed
files, source/artifact digests, remaining limitations and appropriate evidence
classes. Live checks stay outside ordinary deterministic verification commands.
