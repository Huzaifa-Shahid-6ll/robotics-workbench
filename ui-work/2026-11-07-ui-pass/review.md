# Independent review

An independent reviewer examined the integrated diff, checked native feature coverage, and inspected representative Agent, Components, Documents, KiCad and CAD browser renders. Findings and repairs follow.

| Finding | Consequence | Resolution |
|---|---|---|
| Shared sheet extraction omitted project header and empty-state rules | Wiring and telemetry lost spacing and reflow rules | Moved the shared selectors to `workbench.css`. |
| Agent removed focused Stop control on a terminal transition | Keyboard focus could fall to the page body | Transfer focus to the task details summary when the focused control is removed. |
| Same-procedure comparisons reused the same display label | Run identity was ambiguous in the plot and exact table | Use the retained run title and a distinguishing experiment ID suffix for duplicates. |
| CAD stale copy attributed every stale artifact to a change or failed generation | Copy could suggest an unsupported cause | Label the artifact outdated and expose its retained revision and digest. |
| Native status could show mutable selection next to an earlier receipt | User could read the wrong target for an operation | Use the receipt's kind, status and device ID in operation status. |
| Native conflict diff showed the historical baseline instead of current editor text | Reviewer could miss unsaved user changes | Show labelled current and retained text without changing the mutation guards. |

The document page control can use less vertical space at desktop width. Remaining functional and verification gaps are listed by surface in [coverage](screen-coverage.json).
