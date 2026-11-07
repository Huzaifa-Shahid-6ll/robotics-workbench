# Decisions

- Keep the native tree, Quick Picks, output, diff and recovery. Group existing startup, compile, device selection and upload entry points together in the Robotics tree. Tool output distinguishes companion, Arduino CLI inspection and where to check optional tools.
- Share the foundation across existing webview bundles through `workbench.css`. Existing entry points still emit and load their own CSS bundle. Use native HTML controls and current host colors for focus and selection.
- The Agent retains newer composer text when a preceding message is acknowledged. It stores only the existing draft and selected subview in local webview state. Task details disclose secondary actions while the task and tool states stay separately visible.
- A conflict diff compares a snapshot of the current scoped editor or saved file to the retained version and labels both sides. The source edit guards still reject a conflicted revert. The historical baseline remains in the retained record.
- Overlay telemetry only when the compared windows use host-receive elapsed time. Use separate axes for different units, and retain exact sample tables for other clocks and missing samples.
- When a preview cannot render, keep native handoff and retained identity visible. Geometry interaction continues in the supported external viewer. Separate KiCad check completion from its validation verdict.
- Keep generated fixture screenshots, logs and packages under the ignored `artifacts/ui-pass/` tree. Baseline Wiring and Telemetry screenshots use the previous retained TASK-11 run because those files changed before a fresh baseline capture.
