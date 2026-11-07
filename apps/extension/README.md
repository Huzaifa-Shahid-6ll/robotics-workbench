# Robotics Workbench

A local Windows x64 VS Code extension for ordinary Arduino sketches, agent-assisted source work, intended wiring, and recorded experiments.

1. Install the Windows VSIX in VS Code.
2. Open the folder containing your sketch and run **Robotics: Import Existing Sketch**.
3. Run **Robotics: Check Tools**, then **Robotics: Compile**.

The preview uses a local Node 24.18.0 runtime. The tested toolchain and optional Codex, OpenCode, KiCad, and CAD setup are in the [Windows quickstart](https://github.com/Huzaifa-Shahid-6ll/robotics-workbench/blob/main/docs/quickstart.md). For releases and troubleshooting, visit the [public repository](https://github.com/Huzaifa-Shahid-6ll/robotics-workbench).

Compilation, exact-artifact upload, and physical observation have separate evidence. Upload requires a selected observed device and an explicit artifact confirmation. Restricted Mode permits static navigation and keeps execution disabled.

Robotics Workbench source is MIT licensed. Bundled dependencies retain their own notices in `dist/THIRD-PARTY-NOTICES.txt`.
