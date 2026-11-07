# TASK-06 source review boundary

Deterministic fixtures are created in disposable temporary projects by
`apps/extension/test/task-review.test.ts`. Tests cover exact-source revert,
dirty user buffer plus external provider edit, later saved edits, proposed
Apply/Dismiss, task-added/deleted files, private/linked/binary/oversized inputs,
corrupt retained content, and monotonic manifest revision on intent revert.

Executed 2026-11-02:

```text
node -e "require('esbuild').buildSync({entryPoints:['apps/extension/test/task-review.test.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',external:['vscode'],outfile:'artifacts/task06-review-tests.cjs'})"
node --test artifacts/task06-review-tests.cjs
npx tsc --noEmit
```

Twelve deterministic tests and TypeScript passed, including decline/missing
confirmation and saved/dirty edits during the confirmation. Native VS Code diff/editor
behavior remains an installed-host integration check; fake hosts establish no
hardware or physical wiring claim.

Current primary documentation was retrieved through Context7:
https://code.visualstudio.com/api/extension-guides/virtual-documents and
https://code.visualstudio.com/api/references/vscode-api. The module registers a
readonly `TextDocumentContentProvider`, opens `vscode.diff`, and applies a minimal
`TextEditor.edit` only after checking the reviewed saved hash and host version.
Registration lifetime belongs to `TaskReview.dispose()`.

Snapshots flow through the root-owned companion SQLite/artifact storage seam;
there is no second editable source authority. Source acceptance/revert never
uploads firmware. A changed manifest receives a new design revision.

An external change observed during a task is labelled writer-unverified. A
source revert first opens the exact retained diff and requires an explicit
per-file confirmation of its complete shown changes and SHA-256 identities.
Production uses a native modal; installed synthetic tests may inject only the
confirmation result through `nativeReviewHost(callback)` while retaining actual
native diff/edit behavior. A missing confirmation callback in a custom host
denies the revert. Source and editor preconditions are rechecked afterward.
