# Windows quickstart

## What you need

- Local Windows x64 and VS Code. The preview was exercised with VS Code 1.144.0 and Node 24.18.0.
- Arduino CLI 1.5.1 for compilation. The tested exact-artifact upload path uses Arduino AVR core 1.8.8 and `arduino:avr:uno`.
- An existing Arduino sketch folder. Codex, OpenCode, KiCad and the CAD environment are optional.

## Install and compile

1. Download the VSIX and SHA-256 file from the [Windows preview](https://github.com/Huzaifa-Shahid-6ll/robotics-workbench/releases/tag/v0.1.0). To verify the download in PowerShell, run `Get-FileHash .\robotics-workbench-0.1.0.vsix -Algorithm SHA256` and compare it with the release checksum.
2. In VS Code, open the Command Palette and run **Extensions: Install from VSIX…**. Select the downloaded file.
3. Open a local folder that contains an ordinary sketch. Grant Workspace Trust only for a folder you trust. Run **Robotics: Import Existing Sketch** and choose the compiler target.
4. Run **Robotics: Check Tools**. If discovery needs help, use the existing executable paths in `roboticsWorkbench.nodePath` and `roboticsWorkbench.arduinoPath`.
5. Run **Robotics: Compile**, review any save prompt, and read compiler diagnostics in the Problems view.

## Upload and observe

Use **Robotics: Select Observed Device** to identify the board. **Robotics: Upload Exact Artifact** shows the artifact and device before confirmation. **Robotics: Record Raw Serial** starts a separate capture. Opening the serial port can reset the Uno. An uploader receipt establishes what the uploader reported. A physical test needs its own recorded observation.

[Installation and troubleshooting](personal-installation-and-troubleshooting.md) · [Full workbench guide](workbench-guide.md) · [Report a problem](https://github.com/Huzaifa-Shahid-6ll/robotics-workbench/issues/new/choose)
