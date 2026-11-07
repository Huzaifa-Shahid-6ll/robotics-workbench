import { mkdirSync, existsSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { kicadFixture } from '../../../packages/test-fixtures/kicad/fixtures';

/** Test-only ordinary source fixture. No device, build, upload or physical measurement. */
export function seedEngineering(root: string, data: string) {
  for (const path of [root, data]) {
    if (existsSync(path) && readdirSync(path).length) throw Error('Engineering fixture requires empty directories.');
    mkdirSync(path, { recursive: true });
  }
  const { manifest, mapping, definition } = kicadFixture(); manifest.projectId = randomUUID();
  manifest.name = 'Synthetic engineering handoff fixture';
  for (const path of ['components', 'mechanical', 'FixtureSketch']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(root, 'FixtureSketch/FixtureSketch.ino'), '// Synthetic fixture; not compiled or uploaded.\nvoid setup(){}\nvoid loop(){}\n');
  writeFileSync(join(root, 'components/catalog.json'), JSON.stringify({ schemaVersion: 1, definitions: [definition] }));
  writeFileSync(join(root, 'components/kicad.json'), JSON.stringify(mapping, null, 2));
  const fixture = resolve(__dirname, '../packages/test-fixtures/cad');
  for (const file of ['assets.json', 'box.py', 'box_dimensions.py', 'parameters.json']) copyFileSync(join(fixture, file), join(root, 'mechanical', file));
  const python = process.env.WORKBENCH_TASK10_CAD_PYTHON;
  const environment = python ? JSON.parse(execFileSync(python, ['-I', '-c', "import importlib.metadata,json,platform;print(json.dumps({'python':platform.python_version(),'packages':{d.metadata['Name'].lower().replace('_','-').replace('.','-'):d.version for d in importlib.metadata.distributions()}}))"], { encoding: 'utf8', windowsHide: true, timeout: 30000 })) : { python: 'unconfigured', packages: {} };
  writeFileSync(join(root, 'mechanical/environment.lock.json'), JSON.stringify(environment, null, 2));
  return { projectId: manifest.projectId, assetId: '99999999-9999-4999-8999-999999999999', mappingPath: 'components/kicad.json' };
}
if (require.main === module) {
  const [root, data] = process.argv.slice(2);
  if (!root || !data) throw Error('Expected fixture project and data directories.');
  process.stdout.write(JSON.stringify(seedEngineering(resolve(root), resolve(data))));
}
