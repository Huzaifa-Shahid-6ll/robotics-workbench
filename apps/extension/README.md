# Robotics Workbench — scaffold

Initial Windows desktop VS Code host. Open the Robotics activity bar or run
**Robotics: Check Tools** to connect to the local Node companion. Restricted Mode
permits static navigation only. Requires a local Node 24 runtime (tested 24.18.0).
Set the machine setting `roboticsWorkbench.nodePath` if Node is absent from PATH.

This increment has no provider sessions, project conversion, compiler, uploader,
serial, CAD or schematic implementation. The project-bound companion has validated
domain contracts, SQLite receipts and immutable artifact storage; these APIs have
no project setup UI yet. Their complete scope is retained
in the supplied specifications. No project source or device is modified.

The extension owns the companion lifetime. Deactivation requests shutdown and
waits for process exit; a lost parent IPC channel also releases its ownership.
