# Contributing

Use [Discussions](https://github.com/Huzaifa-Shahid-6ll/robotics-workbench/discussions) for questions and early design ideas. Use [Issues](https://github.com/Huzaifa-Shahid-6ll/robotics-workbench/issues/new/choose) for reproducible bugs and scoped requests. Check the [roadmap](ROADMAP.md) before starting a substantial change.

1. Fork the repository and branch from `main`.
2. Read [AGENTS.md](AGENTS.md), the [architecture map](docs/repository-and-module-map.md), and the relevant [task packet](docs/implementation-plan-and-task-packets.md).
3. On local Windows x64, install the locked dependencies with `npm ci --ignore-scripts`. Run `npm run check` and `npm test`. Run `npm run test:host` if the change depends on native VS Code behavior.
4. In the pull request, name the behavior changed and the checks you actually ran. Label synthetic fixtures and real-host or hardware evidence separately.

Keep ordinary sketch files and device ownership intact. Use synthetic fixtures for automated tests. Any physical upload, wiring change, or measurement belongs in a separate, explicitly prepared test. Review logs and screenshots for tokens, private paths, and device serial numbers before posting them.

See [SECURITY.md](SECURITY.md) for private reporting and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.
