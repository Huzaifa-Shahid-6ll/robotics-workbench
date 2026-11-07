import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchematic, inertSvg, inspectNative, inspectSymbolTable, netlistEndpoints, parseErc } from '../src/index';
import { ercReport, fixtureNetlist, kicadFixture, safeSvg } from '../../../test-fixtures/kicad/fixtures';

test('explicit component mapping generates deterministic self-contained source and exact stable endpoints', () => {
  const { manifest, mapping, definition } = kicadFixture(), generated = generateSchematic(manifest, [definition], mapping);
  assert.equal(generated.text, generateSchematic({ ...manifest, components: [...manifest.components].reverse() }, [definition], { ...mapping, components: [...mapping.components].reverse() }).text);
  assert.equal(inspectNative(generated.text).symbolCount, 2);
  assert.deepEqual(netlistEndpoints(fixtureNetlist), generated.expectedNets);
  assert.equal(generated.mappings.length, 4); assert.match(generated.library, /kicad_symbol_lib/); assert.match(generated.symbolTable, /KIPRJMOD/);
  assert.throws(() => generateSchematic({ ...manifest, components: [{ ...manifest.components[0], definition: null }, manifest.components[1]] }, [definition], mapping), { code: 'KICAD_UNRESOLVED_SYMBOL' });
  const unsupported = structuredClone(mapping); unsupported.components[0].pins[0].pinId = 'ALIAS';
  assert.throws(() => generateSchematic(manifest, [definition], unsupported), { code: 'KICAD_UNRESOLVED_PIN' });
  assert.throws(() => generateSchematic(manifest, [definition], { ...mapping, template: 'guessed-symbol' }), { code: 'KICAD_UNRESOLVED_MAPPING' });
});
test('structural native inspection refuses hierarchy, unknown formats and incomplete embedded libraries without editing bytes', () => {
  const { manifest, mapping, definition } = kicadFixture(), text = generateSchematic(manifest, [definition], mapping).text;
  assert.throws(() => inspectNative(text.replace('(version 20250114)', '(version 20991231)')), { code: 'KICAD_UNSUPPORTED_FORMAT' });
  assert.throws(() => inspectNative(text.replace('(paper "A3")', '(paper "A3") (sheet (uuid "00000000-0000-4000-a000-000000000000"))')), { code: 'KICAD_UNSUPPORTED_HIERARCHY' });
  assert.throws(() => inspectNative(text.replace('(lib_id "Workbench:', '(lib_id "Missing:')), { code: 'KICAD_MISSING_LIBRARY' });
  assert.throws(() => inspectNative(text.slice(0, -5)), { code: 'KICAD_INVALID_SOURCE' });
  const table = generateSchematic(manifest, [definition], mapping).symbolTable; inspectSymbolTable(table);
  assert.throws(() => inspectSymbolTable(table.replace('${KIPRJMOD}/Workbench.kicad_sym', 'C:/external/symbols.kicad_sym')), { code: 'KICAD_UNSUPPORTED_LIBRARY' });
  assert.throws(() => inspectSymbolTable('(sym_lib_table (lib (name "Workbench") (type "KiCad") (uri C:/outside) (options "") (descr "(uri \\\"${KIPRJMOD}/Workbench.kicad_sym\\\")")))'), { code: 'KICAD_UNSUPPORTED_LIBRARY' });
});
test('native ERC execution success is distinct from severity verdict and report mismatch is a failure', () => {
  assert.deepEqual(parseErc(ercReport(), 0), { verdict: 'pass', diagnostics: [] });
  for (const severity of ['warning', 'error'] as const) { const result = parseErc(ercReport(severity), 5); assert.equal(result.verdict, 'fail'); assert.equal(result.diagnostics[0].severity, severity); }
  assert.equal(parseErc(ercReport('exclusion'), 5).verdict, 'pass');
  assert.throws(() => parseErc(ercReport('error'), 0), { code: 'KICAD_INVALID_REPORT' });
  assert.throws(() => parseErc('{"sheets":[]}', 5), { code: 'KICAD_INVALID_REPORT' });
});
test('preview sanitizer rejects scripts and every external resource route while retaining passive geometry', () => {
  assert.equal(inertSvg(safeSvg), safeSvg);
  const nativeDeclaration = '<?xml version="1.0" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';
  assert.equal(inertSvg(nativeDeclaration + safeSvg).trim(), safeSvg);
  for (const markup of ['<script>alert(1)</script>', '<foreignObject/>', '<image href="https://example.invalid/image"/>', '<g onload="alert(1)"/>', '<style>@import "https://example.invalid/x";</style>', '<path style="fill:url(https://example.invalid/x)"/>', '<use xlink:href="file:///private"/>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]>']) assert.throws(() => inertSvg(safeSvg.replace('</svg>', `${markup}</svg>`)), { code: 'KICAD_UNSAFE_PREVIEW' });
});
