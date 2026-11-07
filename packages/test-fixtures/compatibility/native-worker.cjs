// Isolated packaging spike only; production exposes no command to run this worker.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { autoDetect } = require('./vendor/node_modules/@serialport/bindings-cpp');
const { mkdirSync, mkdtempSync, writeFileSync, realpathSync, readFileSync } = require('node:fs');
const { join, isAbsolute, relative } = require('node:path');

async function main() {
  const root = process.argv[2];
  assert.ok(root && isAbsolute(root), 'Explicit project-local spike data root required');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(realpathSync(root), 'native-'));
  const databasePath = join(directory, 'probe.sqlite');
  let database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE probe(value INTEGER NOT NULL); INSERT INTO probe VALUES (42); BEGIN; UPDATE probe SET value=99; ROLLBACK;');
  database.close();
  database = new DatabaseSync(databasePath);
  assert.equal(database.prepare('SELECT value FROM probe').get().value, 42);
  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  database.close();

  // A newly created ordinary file cannot designate a board; never enumerate ports.
  const path = join(directory, 'not-a-serial-port.txt');
  const sentinel = 'Owned ordinary file for native serial negative-path test.\n';
  writeFileSync(path, sentinel, { flag: 'wx' });
  const binding = autoDetect();
  assert.equal(process.platform, 'win32');
  let serialError;
  try {
    const port = await binding.open({ path, baudRate: 9600 });
    await port.close();
    assert.fail('Ordinary file unexpectedly accepted as a serial port');
  } catch (error) {
    assert.notEqual(error.code, 'ERR_ASSERTION');
    serialError = String(error.message).slice(0, 200);
  }
  assert.ok(serialError);
  assert.equal(readFileSync(path, 'utf8'), sentinel);
  writeFileSync(path, sentinel);
  for (const loaded of Object.keys(require.cache)) {
    const local = relative(__dirname, loaded);
    assert.ok(!isAbsolute(local) && !local.startsWith('..'), 'Probe resolved a dependency outside its installed VSIX');
  }
  process.stdout.write(JSON.stringify({ passed: true, nodeVersion: process.version,
    runtimePath: process.execPath, modulesAbi: process.versions.modules, napi: process.versions.napi,
    sqliteVersion, durableDatabaseReopen: true, transactionRollback: true,
    serialBindingLoaded: true, serialOrdinaryFileRejected: true, serialError,
    allRuntimeModulesInsideInstalledVsix: true, physicalDeviceAccessed: false, directory })+'\n');
}
main().catch(error => { process.stderr.write(String(error)+'\n'); process.exitCode = 1; });
