# TASK-07 pure wiring boundary

This fixture supplies synthetic definitions and manifests for deterministic software tests. The sources, review labels, voltages and confirmations represent no real component, electrical measurement or assembled circuit.

The domain exports `componentPins`, `canonicalEndpoint`, `canonicalizeNets` and `validateWiring`. The application exports `isWiringOperations` and `planWiring(manifest, expectedRevision, operations, catalog)`. Both use the version 1 shared contracts. The plan contains the proposed manifest, exact metadata and order restoration operations, a human review summary, finite validation results and conservative confirmation invalidation. The host remains responsible for native buffer/file compare-and-swap, persistence, ordinary-proposal rejection of inverse-only operations, and accepting the reviewed transaction.

Nets are unordered explicit endpoint sets. Geometry is absent from this API; a line crossing cannot create membership. Alias resolution preserves component/net/binding IDs. Semantic no-ops preserve the revision and original representation. A changed patch advances the manifest revision once. Definition migrations retain provenance and require mappings for referenced pins absent from the chosen target definition. Component removal requires explicit binding-removal approval, preserves source files and historical records, and restores affected records through reviewed inverse operations.

The finite rules check resource allocation, chosen modes, known incompatible driven outputs, reviewed intended voltage bounds, represented bus participation, required connections and explicit binding references. Missing, candidate and typical facts cannot establish recommended operation. Absolute maximum bounds may identify an incompatibility but cannot establish recommended operation. Shared open-drain bus membership is permitted; addresses, pull-ups, timing, loading, firmware and physical continuity remain unchecked. Source symbols and expressions remain explicit associations without automatic firmware rewriting.

Owning documents: D14, D15, D27, D34, D35, D13, D18. Requirements: REQ-HW-34-01, REQ-HW-35-01. Changed paths: this directory, `packages/domain/src/wiring.ts`, `packages/domain/test/wiring.test.ts`, `packages/application/src/wiring/index.ts`, `packages/application/test/wiring.test.ts`. Root integration owns shared contracts, exports, native host/service behavior and TASK-07 completion evidence.

Executed on 2026-11-03, with TEMP/TMP and npm cache scoped to workspace artifacts on G:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node -e "require('esbuild').buildSync({entryPoints:['packages/domain/test/wiring.test.ts','packages/application/test/wiring.test.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outdir:'artifacts/task07-wiring',outbase:'.',outExtension:{'.js':'.cjs'}})"
node --test artifacts/task07-wiring/packages/domain/test/wiring.test.cjs artifacts/task07-wiring/packages/application/test/wiring.test.cjs
```

Result: typecheck passed; 15 tests passed. Logs: `artifacts/task07-wiring/typecheck.log`, `artifacts/task07-wiring/tests.log`. This module does not claim release acceptance, real USB behavior, native-host integration coverage or measured circuit verification.
