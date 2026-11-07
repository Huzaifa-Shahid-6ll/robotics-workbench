---
doc_id: D07
title: "Quality and performance budgets"
status: implementation-spec
updated: 2026-11-01
depends_on: [D03, D06]
requirement_ids: [REQ-UX-05, REQ-ARCH-03, REQ-HW-03]
---

# Quality and performance budgets

## Purpose and authority

**SPECIFIED:** This document defines how performance and reliability are measured on the user's actual PC. The initial numeric limits below are engineering targets, not measured results or vendor claims. G0 establishes a baseline; any revised budget requires a recorded decision and retained before/after data. D19 owns job scheduling; D33 owns recording integrity; D47 owns detailed accessibility behavior.

## Measurement environment

Record OS build, CPU/RAM, available disk space, VS Code version/profile, extension version, tool versions, power mode, workspace fixture, and concurrent processes. Compare the same VS Code profile with and without the workbench. Attribute incremental workbench process-tree memory separately from provider, compiler, language-server, and CAD peaks. Do not hide the latter: report them as separate totals.

Fixtures MUST include a small existing Uno sketch, a multi-file sketch, a 100-component design, a 10,000-row generated log, and a 30-minute serial stream. These are initial test sizes, not promises of arbitrary scale. Real serial tests record actual baud/framing; replay tests are labeled synthetic.

## Initial budgets

| Metric | Initial target | Measurement and failure action |
|---|---|---|
| Unused features | Zero provider/CAD/KiCad workers before requested | Inspect process tree after ordinary VS Code startup |
| Visible command acknowledgement | p95 ≤150 ms for local click/key feedback | 30 warm commands; operation completion excluded |
| Local cached selection/context update | p95 ≤250 ms on reference fixture | Selection to rendered matching revision; record cache misses separately |
| Warm lightweight activation | ≤1 s | Host activation instrumentation; exclude first download/tool startup |
| Idle incremental workbench memory | ≤250 MiB total across extension-attributed work and companion, excluding optional workers | Measure after 60 s idle; investigate exceedance rather than suppressing features silently |
| Stream display storage | Bounded ring/window, default 10,000 rendered rows maximum | Memory plateau over 30 min; older records remain on disk |
| Context tool response | Default ≤16 KiB text payload per call; hard ceiling 32 KiB | D26/D29 own the 100-record default and stricter method caps; any explicit expansion stays within 32 KiB and exposes continuation handles |
| Background heavy work | One compile/CAD/document-heavy job at a time by default | Queue explicitly; raise only after actual profiling |
| Shutdown | No orphaned workbench child processes after 10 s graceful-stop deadline | Force-stop only owned safe processes; reconcile effects as unknown when needed |

Compile, provider generation, CAD generation, and upload completion do not receive invented universal time limits. Their adapters define cancellation and diagnostic timeouts by supported tool behavior. The UI MUST acknowledge progress without claiming completion early.

## Reliability and evidence budgets

There MUST be no silent raw-capture loss. If buffers or disk cannot keep up, record lost-byte/sample estimates where known, mark gaps, and degrade or stop capture explicitly. Plot downsampling MUST NOT modify raw recordings. A very long serial line cannot grow memory without bound; retain raw bytes while limiting displayed parsing windows.

An interrupted hardware mutation MUST NOT be automatically replayed. Capture metadata and operation intent are persisted early enough to reconstruct uncertainty after restart. At most one coordinated owner accesses a device. A service lock does not prevent external applications from opening a port; contention is a normal error case.

## Resource controls

Heavy work belongs in the companion or child processes, not synchronous extension-host code. Watch only relevant paths and exclude build outputs/caches from broad indexing. Use cached projections keyed by authoritative hashes and relevant tool versions. Destroy or suspend hidden webviews; restore compact view state on reopen. Optional OCR, CAD, and providers are lazy features.

Data location is configurable. If the chosen drive is missing or full, do not silently redirect large artifacts to C:. Evidence retention and regenerable cache cleanup are separate policies. User projects and recordings are never deleted as an automatic performance fix.

## Accessibility and perceived performance

All core journeys MUST work at 1366×768 with collapsible secondary panes. Keyboard focus remains visible during loading and failures. Reduced-motion mode removes unnecessary movement. Loading states identify the operation and allow cancellation where supported; indefinite spinners without diagnostics are failures even when the tool is still running.

## Acceptance criteria

- **AC-D07-01:** Baseline report records all environment fields and distinguishes observed metrics from budgets.
- **AC-D07-02:** Thirty-minute capture/replay has bounded display memory and explicit gaps under injected overload.
- **AC-D07-03:** Repeated open/close of all custom panels creates no steadily growing listeners/processes.
- **AC-D07-04:** Exceeding a budget produces an issue with traces and a mitigation, not a fabricated pass.
- **AC-D07-05:** Slow compile/provider/CAD jobs leave editor input usable and show truthful progress/cancellation state.

## Sources and related documents

**RESEARCH-RECORDED:** [VS Code webview guidance](https://code.visualstudio.com/api/extension-guides/webview), [extension host](https://code.visualstudio.com/api/advanced-topics/extension-host), [performance diagnostics](https://github.com/microsoft/vscode/wiki/Performance-Issues). Numbers above are project targets.

Related: [jobs](jobs-and-process-supervision.md), [serial](serial-monitor-and-telemetry.md), [accessibility](accessibility-responsive-layout-and-motion.md), [validation gates](unknowns-and-validation-spikes.md).
