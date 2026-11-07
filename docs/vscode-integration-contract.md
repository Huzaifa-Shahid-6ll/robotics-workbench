---
doc_id: D13
title: "VS Code integration contract"
status: implementation-spec
updated: 2026-11-01
depends_on: [D11, D18]
requirement_ids: [REQ-ARCH-02, REQ-ARCH-06]
---

# VS Code integration contract

## Authority and platform

**SPECIFIED:** This document owns contributions to the host editor and document lifecycle. Use stable VS Code extension APIs only. The workbench cannot rewrite VS Code's private DOM. UI layout and component appearance are specified in D41–D47. Desktop/local Windows is the initial supported execution environment.

SOURCE-VERIFIED through Context7 on 2026-11-01: webviews communicate through `postMessage`/`onDidReceiveMessage`; `localResourceRoots` limits resource exposure; `webview.cspSource` supports Content Security Policy. Other host behaviors below are RESEARCH-RECORDED from the prior primary-source research and require integration tests against the pinned host.

## Contributions

The provisional command prefix is `roboticsWorkbench`. It is a working identifier, not a final public brand. These are proposed application commands, not built-in VS Code commands.

| Command suffix | Input | Effect |
|---|---|---|
| `openProject` | Optional project URI | Resolve/open project; no automatic source conversion |
| `selectBoard` | projectId | Select compiler target and, separately, observed device |
| `compile` | projectId, optional targetId | Resolve save policy; submit compile operation |
| `upload` | projectId, buildId, deviceId | Preflight exact artifact and request upload |
| `openSerial` | deviceId | Request coordinator monitor ownership |
| `openWiring` | projectId | Open manifest-backed wiring editor |
| `openAgent` | projectId | Reveal agent view; connection happens explicitly |
| `inspectContext` | projectId, optional selection | Show supplied/retrieved/stale context provenance |
| `openExperiments` | projectId | Open recorded-run browser |
| `checkTools` | projectId | Report version/capability readiness |

Contribute a Robotics view container with component, connection, experiment, and reference sections. A compact status item shows selected target/device and current operation; it MUST distinguish configured board from detected device. Keep normal Explorer, terminal, Problems, search, and Git interfaces intact. The agent panel is a movable `WebviewView`. Wiring and experiment views use editor panels; ordinary code review uses native diff.

## Document contract

Use a standard text document-backed editor for `workbench.json`. A diagram edit computes a minimal text edit against the exact observed document version. It MUST preserve unknown supported extension fields and avoid reformatting the whole file for a node-position change. Diagram positions are presentation metadata, separate from electrical meaning.

An invalid intermediate JSON edit displays an invalid-document state and disables graph mutations; the original text remains editable. A previously rendered diagram may remain as a clearly stale preview, never as current authority. Undo/redo, edits from another view, and external changes rerender without emitting a second write loop.

Before compiling, identify all relevant dirty documents. Default policy is explicit save-and-build: request host save, verify success, then create a source snapshot. Failed or declined save stops the compile request. A later labeled snapshot-build mode requires its own implementation gate; do not silently compile disk while implying the visible buffer was tested.

External CLI agents can edit disk outside `WorkspaceEdit`. On conflict with dirty buffers, preserve both versions, mark the change set conflicted, and request resolution before apply/revert/build. A provider's direct disk edit is not magically atomic because the UI uses VS Code.

## View lifecycle and diagnostics

Every event subscription, timer, watcher, output channel, and webview listener is disposed through host lifecycle ownership. Hidden expensive views pause rendering/subscriptions or retain only bounded state; avoid keeping all views alive to preserve data that belongs in the companion.

Compile diagnostics include sourceSnapshotId, target/configuration identity, file location, severity, and original diagnostic text. If current source differs, label diagnostics stale or clear their active applicability. Never attribute an old successful build to new source. Navigation uses host URIs and document APIs rather than string-concatenated paths.

## Trust and settings

In Restricted Mode, allow static project browsing and documentation that do not execute project-controlled code. Disable agent startup, build/upload, CAD scripts, and executable-path overrides until host trust permits them. Tool settings use explicit scope: application/machine executable configuration cannot be silently overridden by untrusted workspace data. Secrets use the approved credential boundary in D20.

Webviews require a restrictive CSP, extension-owned bundled assets, narrowly scoped local-resource roots, and schema validation of every incoming message. Render source/serial/model output as data. Do not enable raw HTML execution to improve Markdown fidelity.

## Errors and recovery

A lost companion connection changes the status to disconnected while keeping files usable. Reopening a webview requests a current snapshot. A failed editor operation reports the actual resulting file state; mixed resource/text edits are not promised atomic. Unsupported remote placement presents a clear explanation and preserves read-only views.

## Acceptance criteria

- **AC-D13-01:** Text edit, diagram edit, undo, redo, and external file update converge across two open views without a write loop.
- **AC-D13-02:** Invalid manifest text survives close/reopen and can be repaired without data loss.
- **AC-D13-03:** A dirty-buffer conflict from an external agent blocks destructive revert and preserves both versions.
- **AC-D13-04:** Untrusted project settings cannot start a configured executable.
- **AC-D13-05:** A recreated view restores from service state and does not duplicate an operation.

## Sources

[Webviews](https://code.visualstudio.com/api/extension-guides/webview), [custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors), [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [VS Code API](https://code.visualstudio.com/api/references/vscode-api), [virtual documents](https://code.visualstudio.com/api/extension-guides/virtual-documents).
