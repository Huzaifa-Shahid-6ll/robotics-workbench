import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const nativeBinary = 'vendor/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node';
export const canvasNativeBinary = 'vendor/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = path => path.split(sep).join('/');

/** Stage the installed runtime dependency closure, excluding build sources and other platforms. */
export async function stageNativeRuntime(destination = resolve('apps/extension/dist')) {
  const vendor = join(destination, 'vendor');
  assert.equal(await realpath(destination), resolve(destination), 'Native output cannot traverse links.');
  try {
    assert.equal(await realpath(vendor), resolve(vendor), 'Native output cannot traverse links.');
    await rm(vendor, { recursive: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packages = [], files = [], copied = new Map();
  async function dependency(name, from) {
    let location = dirname(createRequire(from).resolve(name)), pkg;
    while (!pkg) {
      try { const candidate = JSON.parse(await readFile(join(location, 'package.json'), 'utf8')); if (candidate.name === name) pkg = candidate; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!pkg) { const parent = dirname(location); assert.notEqual(parent, location); location = parent; }
    }
    if (copied.has(name)) { assert.equal(copied.get(name), pkg.version, 'Conflicting native runtime dependency versions require nested packaging.'); return; }
    copied.set(name, pkg.version);
    let licenseFile = (await readdir(location)).find(file => /^licen[cs]e(?:\.(md|txt))?$/i.test(file));
    let inheritedLicense;
    if (!licenseFile && name === '@napi-rs/canvas-win32-x64-msvc') {
      assert.equal(pkg.license, 'MIT');
      inheritedLicense = createRequire(from).resolve('@napi-rs/canvas/package.json');
      inheritedLicense = join(dirname(inheritedLicense), 'LICENSE');
      licenseFile = 'LICENSE';
    }
    assert.ok(licenseFile, `Missing native redistribution license: ${name}@${pkg.version}`);
    const prefix = `vendor/node_modules/${name}`;
    packages.push({ name, version: pkg.version, license: pkg.license, ...(pkg.repository ? { source: pkg.repository } : {}), licensePath: `${prefix}/${licenseFile}` });
    if (inheritedLicense) {
      const path = `${prefix}/${licenseFile}`, bytes = await readFile(inheritedLicense);
      await mkdir(join(destination, prefix), { recursive: true }); await copyFile(inheritedLicense, join(destination, path));
      files.push({ path, sha256: sha256(bytes), sizeBytes: bytes.length });
    }
    async function copy(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const source = join(directory, entry.name), local = posix(relative(location, source));
        if (entry.isSymbolicLink()) throw new Error(`Runtime package contains a link: ${name}/${local}`);
        if (entry.isDirectory()) {
          if (['node_modules', 'test', 'tests', 'tools', '.git'].includes(entry.name)) continue;
          if (name === 'pdfjs-dist' && !['legacy', 'legacy/build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'].includes(local)) continue;
          if (local.startsWith('prebuilds/') && local !== 'prebuilds/win32-x64') continue;
          await copy(source); continue;
        }
        const pdfAsset = name === 'pdfjs-dist' && (['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'].includes(local) || /^(?:cmaps|standard_fonts|iccs)\//.test(local) || (local.startsWith('wasm/') && !/quickjs/.test(local)));
        const selected = local === 'package.json' || local === licenseFile || pdfAsset || (name !== 'pdfjs-dist' && /\.(?:js|cjs|mjs|json)$/.test(local)) || (local.startsWith('prebuilds/win32-x64/') && local.endsWith('.node')) || (name === '@napi-rs/canvas-win32-x64-msvc' && ['skia.win32-x64-msvc.node', 'icudtl.dat'].includes(local));
        if (!selected) continue;
        const info = await lstat(source); assert.ok(info.isFile() && info.nlink === 1, 'Only ordinary runtime files may be bundled.');
        const path = `${prefix}/${local}`, target = join(destination, path), bytes = await readFile(source);
        await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
        files.push({ path, sha256: sha256(bytes), sizeBytes: bytes.length });
      }
    }
    await copy(location);
    for (const child of Object.keys(pkg.dependencies ?? {}).sort()) await dependency(child, join(location, 'package.json'));
  }
  await dependency('@serialport/bindings-cpp', import.meta.url);
  await dependency('pdfjs-dist', import.meta.url);
  await dependency('@napi-rs/canvas', import.meta.url);
  await dependency('@napi-rs/canvas-win32-x64-msvc', import.meta.url);
  assert.ok(files.some(item => item.path === nativeBinary), 'Installed win32-x64 native prebuild is required.');
  assert.ok(files.some(item => item.path === canvasNativeBinary), 'Installed win32-x64 canvas prebuild is required.');
  const inventory = { schemaVersion: 1, target: 'win32-x64', bindingPackage: '@serialport/bindings-cpp', packages: packages.sort((a, b) => a.name.localeCompare(b.name)), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  await writeFile(join(destination, 'native-runtime.json'), JSON.stringify(inventory, null, 2) + '\n');
  await verifyNativeRuntime(destination);
  return inventory;
}

export async function verifyNativeRuntime(directory) {
  const inventory = JSON.parse(await readFile(join(directory, 'native-runtime.json'), 'utf8'));
  assert.equal(inventory.schemaVersion, 1); assert.equal(inventory.target, 'win32-x64');
  assert.ok(inventory.files.some(item => item.path === nativeBinary));
  assert.ok(inventory.files.some(item => item.path === canvasNativeBinary));
  const expected = new Set(inventory.files.map(item => item.path)); assert.equal(expected.size, inventory.files.length);
  const actual = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name); assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) await walk(child); else actual.push(posix(relative(directory, child)));
    }
  }
  await walk(join(directory, 'vendor')); assert.deepEqual(actual.sort(), [...expected].sort());
  for (const file of inventory.files) {
    assert.ok(file.path.startsWith('vendor/node_modules/') && !file.path.split('/').includes('..'));
    const bytes = await readFile(join(directory, file.path));
    assert.equal(bytes.length, file.sizeBytes); assert.equal(sha256(bytes), file.sha256, `Native asset changed: ${file.path}`);
  }
  return inventory;
}
