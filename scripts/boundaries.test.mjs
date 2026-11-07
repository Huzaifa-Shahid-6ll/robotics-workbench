import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { posix } from 'node:path';

function imports(source) {
  const result = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      result.push({ name: node.moduleSpecifier.text, typeOnly: node.isTypeOnly || node.importClause?.isTypeOnly });
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require')) {
      result.push({ name: ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '<dynamic module>', typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true));
  return result;
}
function violations(path, source) {
  const moduleRoot = path.split('/').slice(0, 2).join('/')+'/';
  return imports(source).filter(({ name, typeOnly }) => {
    if (path.startsWith('packages/contracts/') && /^\.\.\/\.\.\/\.\.\/contracts\/[^/]+\.schema\.json$/.test(name)) return false;
    if (path.startsWith('packages/contracts/') && typeOnly && name === '../../../contracts/provider-adapter') return false;
    if (name.startsWith('.') && !posix.normalize(posix.join(posix.dirname(path), name)).startsWith(moduleRoot)) return true;
    if (path.startsWith('packages/webviews/')) return !(typeOnly && name === '@robotics-workbench/contracts') && !name.startsWith('.') && !['react', 'react-dom/client', 'react/jsx-runtime', '@xyflow/react', '@xyflow/react/dist/style.css', 'uplot', 'uplot/dist/uPlot.min.css', '@robotics-workbench/contracts/telemetry', '@robotics-workbench/contracts/cad', '@robotics-workbench/contracts/kicad'].includes(name);
    if (path.startsWith('packages/contracts/')) return name === 'vscode' || name.startsWith('node:') || name.includes('/apps/');
    if (path.startsWith('packages/domain/')) return !name.startsWith('.') && name !== '@robotics-workbench/contracts';
    if (path.startsWith('packages/application/')) return name === 'vscode' || ['@robotics-workbench/arduino', '@robotics-workbench/serial', '@robotics-workbench/documents', '@robotics-workbench/kicad', '@robotics-workbench/cad', '@robotics-workbench/persistence'].includes(name) || name.startsWith('@robotics-workbench/adapters');
    return name.includes('/src/') && name.includes('packages/');
  });
}
async function sources(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !['node_modules', 'dist', 'test'].includes(entry.name)) result.push(...await sources(path));
    else if (entry.isFile() && /\.tsx?$/.test(path)) result.push(path);
  }
  return result;
}
test('renderer and reusable contract dependency boundaries', async () => {
  for (const path of [...await sources('packages'), ...await sources('apps')]) assert.deepEqual(violations(path, await readFile(path, 'utf8')), [], path);
});
test('boundary checker rejects hostile renderer imports and exports', () => {
  for (const name of ['node:fs', 'fs', 'vscode', '@robotics-workbench/persistence', '@robotics-workbench/adapters/codex', '../../../apps/extension/src/extension']) {
    assert.equal(violations('packages/webviews/src/view.ts', `import x from '${name}';`).length, 1);
    assert.equal(violations('packages/webviews/src/view.ts', `export * from '${name}';`).length, 1);
    assert.equal(violations('packages/webviews/src/view.ts', `const x = require('${name}');`).length, 1);
    assert.equal(violations('packages/webviews/src/view.ts', `const x = import('${name}');`).length, 1);
  }
  assert.equal(violations('packages/webviews/src/view.ts', "import type { ControlResponse } from '@robotics-workbench/contracts';").length, 0);
  assert.equal(violations('packages/webviews/src/view.ts', "import { isParserProfile } from '@robotics-workbench/contracts/telemetry';").length, 0);
  assert.equal(violations('packages/contracts/src/telemetry.ts', "import fs from 'node:fs';").length, 1);
  for (const feature of ['cad', 'kicad']) {
    assert.equal(violations('packages/webviews/src/view.ts', `import { validate } from '@robotics-workbench/contracts/${feature}';`).length, 0);
    assert.equal(violations(`packages/contracts/src/${feature}.ts`, "import fs from 'node:fs';").length, 1);
  }
  for (const name of ['node:fs', 'vscode', '@robotics-workbench/persistence']) {
    assert.equal(violations('packages/domain/src/index.ts', `import x from '${name}';`).length, 1);
  }
});

test('implementation modules have no import cycles', async () => {
  const paths = [...await sources('packages'), ...await sources('apps')];
  const graph = new Map();
  for (const path of paths) {
    const edges = imports(await readFile(path, 'utf8')).filter(item => !item.typeOnly).map(({ name }) => {
      if (name.startsWith('@robotics-workbench/')) {
        const packageName = name.split('/')[1];
        return `packages/${['arduino', 'serial', 'documents', 'kicad', 'cad'].includes(packageName) ? 'adapters/' : ''}${packageName}/src/index.ts`;
      }
      if (!name.startsWith('.')) return undefined;
      const target = posix.normalize(posix.join(posix.dirname(path), name));
      return paths.includes(target+'.ts') ? target+'.ts' : target+'/index.ts';
    }).filter(edge => paths.includes(edge));
    graph.set(path, edges);
  }
  function visit(path, chain = []) {
    assert.ok(!chain.includes(path), `Import cycle: ${[...chain, path].join(' -> ')}`);
    for (const edge of graph.get(path) ?? []) visit(edge, [...chain, path]);
  }
  for (const path of paths) visit(path);
});
