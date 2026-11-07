import { createHash } from 'node:crypto';
import { WorkbenchError, type ComponentDefinition, type KicadDiagnostic, type WorkbenchManifest } from '@robotics-workbench/contracts';
import { findDefinition } from '@robotics-workbench/domain';

export const KICAD_GENERATOR = 'robotics_workbench_1';
export const KICAD_FORMAT = 20250114;
export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function stableUuid(key: string): string { const h = digest(key); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
const fail = (code: string, message: string): never => { throw new WorkbenchError(code, message); };
type Expr = string | Expr[];
/** A bounded structural reader; native files are never rewritten through this parser. */
function parseExpression(text: string, rootName: string): Expr[] {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail('KICAD_INPUT_LIMIT', 'Schematic exceeds the supported 4 MiB input bound.');
  let offset = 0, nodes = 0;
  function read(depth: number): Expr {
    if (depth > 64 || ++nodes > 150000) fail('KICAD_INPUT_LIMIT', 'Schematic nesting or item count exceeds the bounded parser.');
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
    if (text[offset] === '(') { offset++; const children: Expr[] = []; while (true) { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; if (text[offset] === ')') { offset++; return children; } if (offset >= text.length) fail('KICAD_INVALID_SOURCE', 'Unclosed native schematic expression.'); children.push(read(depth + 1)); } }
    if (text[offset] === '"') { offset++; let value = ''; while (offset < text.length) { const ch = text[offset++]; if (ch === '"') return value; if (ch === '\\') { const next = text[offset++]; if (next === undefined) break; value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next; } else value += ch; } return fail('KICAD_INVALID_SOURCE', 'Unclosed native schematic string.'); }
    const start = offset; while (offset < text.length && !/[\s()]/.test(text[offset])) offset++; if (start === offset) fail('KICAD_INVALID_SOURCE', 'Invalid native schematic token.'); return text.slice(start, offset);
  }
  const result = read(0); while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
  if (offset !== text.length || !Array.isArray(result) || result[0] !== rootName) fail('KICAD_INVALID_SOURCE', `Expected one native ${rootName} document.`); return result as Expr[];
}
export const parseSchematic = (text: string): Expr[] => parseExpression(text, 'kicad_sch');
const children = (node: Expr[], name: string): Expr[][] => node.filter((item): item is Expr[] => Array.isArray(item) && item[0] === name);
export function inspectSymbolTable(text: string): void {
  const tree = parseExpression(text, 'sym_lib_table'), libraries = children(tree, 'lib');
  const field = (node: Expr[], name: string): string | undefined => { const fields = children(node, name); return fields.length === 1 && fields[0].length === 2 && typeof fields[0][1] === 'string' ? fields[0][1] : undefined; };
  if (libraries.length !== 1 || field(libraries[0], 'name') !== 'Workbench' || field(libraries[0], 'type') !== 'KiCad' || field(libraries[0], 'uri') !== '${KIPRJMOD}/Workbench.kicad_sym' || field(libraries[0], 'options') !== '') fail('KICAD_UNSUPPORTED_LIBRARY', 'Only the self-contained project-local Workbench symbol table is supported. External libraries require native KiCad handoff; no paths are guessed.');
}
export function inspectNative(text: string): { sheetId: string; symbolCount: number } {
  const tree = parseSchematic(text), version = children(tree, 'version')[0]?.[1];
  if (Number(version) !== KICAD_FORMAT) fail('KICAD_UNSUPPORTED_FORMAT', `Only tested native format ${KICAD_FORMAT} is supported. Open a saved compatible copy in KiCad.`);
  if (children(tree, 'sheet').length) fail('KICAD_UNSUPPORTED_HIERARCHY', 'This release supports one sheet. Open hierarchical projects in native KiCad; no hierarchy is edited or flattened.');
  if (children(tree, 'image').length || children(tree, 'embedded_files').length || children(tree, 'bus').length || children(tree, 'bus_entry').length) fail('KICAD_UNSUPPORTED_OBJECT', 'Embedded files, images and buses require native KiCad handoff; the bounded validator preserves their original file.');
  const library = children(children(tree, 'lib_symbols')[0] ?? [], 'symbol');
  const names = new Set(library.map(item => item[1]));
  for (const item of library) if (children(item, 'extends').length) fail('KICAD_MISSING_LIBRARY', 'Inherited symbols require a complete embedded symbol; no external library is guessed.');
  const symbols = children(tree, 'symbol');
  for (const symbol of symbols) if (!names.has(children(symbol, 'lib_id')[0]?.[1])) fail('KICAD_MISSING_LIBRARY', 'Every native symbol must have its complete embedded definition. Save a self-contained copy in KiCad.');
  const uuid = children(tree, 'uuid')[0]?.[1];
  if (typeof uuid !== 'string' || !/^[a-f0-9-]{36}$/i.test(uuid)) fail('KICAD_INVALID_SOURCE', 'Native root sheet UUID is missing or invalid.');
  return { sheetId: uuid as string, symbolCount: symbols.length };
}
export interface KicadMapping {
  schemaVersion: 1; template: 'pin-block-v1';
  components: { componentId: string; definitionId: string; definitionVersion: string; reference: string; pins: { pinId: string; number: string; noConnect?: boolean }[] }[];
}
export interface EndpointMapping { componentId: string; pinId: string; reference: string; number: string; symbolUuid: string }
export interface GeneratedSchematic { text: string; library: string; symbolTable: string; mappings: EndpointMapping[]; expectedNets: string[][]; sheetId: string }
const quote = (value: string): string => JSON.stringify(value);
const effects = '(effects (font (size 1.27 1.27)))';
const electrical = { input: 'input', output: 'output', bidirectional: 'bidirectional', 'open-drain': 'open_collector', 'power-in': 'power_in', 'power-out': 'power_out', ground: 'power_in', passive: 'passive', unknown: 'unspecified' } as const;
export function generateSchematic(manifest: WorkbenchManifest, catalog: readonly ComponentDefinition[], input: unknown): GeneratedSchematic {
  const mapping = input as KicadMapping;
  const exact = (value: unknown, required: string[], optional: string[] = []): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
  if (!exact(mapping, ['schemaVersion', 'template', 'components']) || mapping.schemaVersion !== 1 || mapping.template !== 'pin-block-v1' || !Array.isArray(mapping.components) || !mapping.components.length || mapping.components.length > 16 || mapping.components.length !== manifest.components.length) fail('KICAD_UNRESOLVED_MAPPING', 'Provide schemaVersion1 pin-block-v1 mapping for every resolved component (maximum 16). Generic blocks are explicit design symbols, not a manufacturer pin drawing.');
  const rootUuid = stableUuid(`${manifest.projectId}:schematic`), mappings: EndpointMapping[] = [], libraries: string[] = [], localLibraries: string[] = [], symbols: string[] = [], decorations: string[] = [], refs = new Set<string>(), ids = new Set<string>(), endpointNet = new Map<string, string>();
  for (const net of manifest.nets) { if (net.members.length < 2) fail('KICAD_UNRESOLVED_MAPPING', 'The bounded generator requires at least two endpoints per net.'); for (const member of net.members) { const key = `${member.componentId}:${member.pinId}`; if (endpointNet.has(key)) fail('KICAD_UNRESOLVED_MAPPING', 'A pin belongs to more than one net. Resolve wiring intent before generating.'); endpointNet.set(key, net.netId); } }
  for (const [index, item] of [...mapping.components].sort((a, b) => String(a.componentId).localeCompare(String(b.componentId))).entries()) {
    if (!exact(item, ['componentId', 'definitionId', 'definitionVersion', 'reference', 'pins']) || typeof item.reference !== 'string' || !/^[A-Z][A-Za-z0-9]{0,15}$/.test(item.reference) || refs.has(item.reference) || ids.has(item.componentId)) fail('KICAD_UNRESOLVED_MAPPING', 'Mappings require unique stable component IDs and native references.'); refs.add(item.reference); ids.add(item.componentId);
    const component = manifest.components.find(component => component.componentId === item.componentId), definition = component && findDefinition(catalog, component.definition);
    if (!component || component.identityStatus === 'unresolved' || !definition || definition.definitionId !== item.definitionId || definition.definitionVersion !== item.definitionVersion) return fail('KICAD_UNRESOLVED_SYMBOL', `Resolve the exact reviewed definition for ${item.componentId} before generation.`);
    if (!Array.isArray(item.pins) || !item.pins.length || item.pins.length > 16 || item.pins.length !== definition.pins.length) fail('KICAD_UNRESOLVED_PIN', `Explicitly map every logical pin of ${item.reference} (maximum 16).`);
    const logical = new Set<string>(), numbers = new Set<string>();
    const pins = [...item.pins].sort((a, b) => String(a.number).localeCompare(String(b.number))).map(pin => {
      if (!exact(pin, ['pinId', 'number'], ['noConnect']) || typeof pin.number !== 'string' || !/^[1-9][0-9]{0,2}$/.test(pin.number) || logical.has(pin.pinId) || numbers.has(pin.number) || pin.noConnect !== undefined && typeof pin.noConnect !== 'boolean') fail('KICAD_UNRESOLVED_PIN', `Invalid or duplicated explicit pin mapping for ${item.reference}.`);
      logical.add(pin.pinId); numbers.add(pin.number); const fact = definition.pins.find(value => value.pinId === pin.pinId);
      if (!fact || fact.electricalType === 'unknown') return fail('KICAD_UNRESOLVED_PIN', `Pin ${item.reference}:${pin.pinId} needs a known electrical type and canonical logical ID.`);
      const net = endpointNet.get(`${item.componentId}:${pin.pinId}`);
      if (!net && pin.noConnect !== true || net && pin.noConnect === true) fail('KICAD_UNRESOLVED_PIN', `Pin ${item.reference}:${pin.pinId} requires one intended net or an explicit noConnect marker.`);
      return { ...pin, fact, net };
    });
    const x = Number((35.56 + index % 4 * 63.5).toFixed(5)), y = Number((25.4 + Math.floor(index / 4) * 60.96).toFixed(5)), libId = `Workbench:Block_${item.componentId}`, localName = `Block_${item.componentId}`, symbolUuid = stableUuid(`${item.componentId}:symbol`), height = (pins.length + 1) * 2.54;
    libraries.push(`(symbol ${quote(libId)} (pin_names (offset 1.016)) (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 2.54 0) ${effects}) (property "Value" ${quote(component.label)} (at 0 0 0) ${effects}) (symbol ${quote(`${localName}_0_1`)} (rectangle (start 0 0) (end 25.4 ${-height}) (stroke (width 0.254) (type default)) (fill (type background)))) (symbol ${quote(`${localName}_1_1`)} ${pins.map((pin, i) => `(pin ${electrical[pin.fact.electricalType]} line (at -5.08 ${-(i + 1) * 2.54} 0) (length 5.08) (name ${quote(pin.pinId)} ${effects}) (number ${quote(pin.number)} ${effects}))`).join(' ')}))`);
    localLibraries.push(libraries.at(-1)!.replace(quote(libId), quote(localName)));
    symbols.push(`(symbol (lib_id ${quote(libId)}) (at ${x} ${y} 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid ${quote(symbolUuid)}) (property "Reference" ${quote(item.reference)} (at ${x + 10} ${y - 2.54} 0) ${effects}) (property "Value" ${quote(component.label)} (at ${x + 10} ${y + height + 2.54} 0) ${effects}) ${pins.map(pin => `(pin ${quote(pin.number)} (uuid ${quote(stableUuid(`${item.componentId}:${pin.pinId}:pin`))}))`).join(' ')} (instances (project "design" (path ${quote(`/${rootUuid}`)} (reference ${quote(item.reference)}) (unit 1)))))`);
    for (const [pinIndex, pin] of pins.entries()) {
      const px = x - 5.08, py = Number((y + (pinIndex + 1) * 2.54).toFixed(5)); mappings.push({ componentId: item.componentId, pinId: pin.pinId, reference: item.reference, number: pin.number, symbolUuid });
      if (!pin.net) decorations.push(`(no_connect (at ${px} ${py}) (uuid ${quote(stableUuid(`${item.componentId}:${pin.pinId}:nc`))}))`);
      else decorations.push(`(label ${quote(`N_${pin.net.replaceAll('-', '')}`)} (at ${px} ${py} 0) ${effects} (uuid ${quote(stableUuid(`${item.componentId}:${pin.pinId}:label`))}))`);
    }
  }
  const expectedNets = manifest.nets.map(net => net.members.map(member => { const pin = mappings.find(pin => pin.componentId === member.componentId && pin.pinId === member.pinId); if (!pin) return fail('KICAD_UNRESOLVED_PIN', 'A net endpoint has no exact component mapping.'); return `${pin.reference}:${pin.number}`; }).sort()).filter(net => net.length > 1).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const text = `(kicad_sch (version ${KICAD_FORMAT}) (generator ${quote(KICAD_GENERATOR)}) (generator_version "1.0") (uuid ${quote(rootUuid)}) (paper "A3") (lib_symbols ${libraries.join('\n')}) ${decorations.join('\n')} ${symbols.join('\n')} (sheet_instances (path "/" (page "1"))) (embedded_fonts no))\n`;
  const library = `(kicad_symbol_lib (version 20241209) (generator ${quote(KICAD_GENERATOR)}) ${localLibraries.join('\n')})\n`;
  const symbolTable = '(sym_lib_table (version 7) (lib (name "Workbench") (type "KiCad") (uri "${KIPRJMOD}/Workbench.kicad_sym") (options "") (descr "Explicit generic workbench blocks")))\n';
  inspectNative(text); return { text, library, symbolTable, mappings, expectedNets, sheetId: rootUuid };
}

/** Parses the pinned CLI's XML endpoint output, never arbitrary native source. */
export function netlistEndpoints(xml: string): string[][] {
  if (Buffer.byteLength(xml) > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('KICAD_INVALID_NETLIST', 'Netlist exceeds bounds or contains unsupported XML declarations.');
  if (!/<export\s+version="E">/.test(xml) || !/<nets\b/.test(xml) || !/<\/export>\s*$/.test(xml)) fail('KICAD_INVALID_NETLIST', 'Native CLI did not produce the tested complete KiCad XML E netlist.');
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]!));
  const result: string[][] = [];
  for (const net of xml.matchAll(/<net\s[^>]*>([\s\S]*?)<\/net>/g)) {
    const endpoints: string[] = [];
    for (const node of net[1].matchAll(/<node\s([^>]*?)\/\s*>/g)) { const attributes = Object.fromEntries([...node[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])])); if (!attributes.ref || !attributes.pin) fail('KICAD_INVALID_NETLIST', 'A native netlist endpoint is missing its reference/pin.'); endpoints.push(`${attributes.ref}:${attributes.pin}`); }
    if (new Set(endpoints).size !== endpoints.length) fail('KICAD_INVALID_NETLIST', 'Native netlist repeats an endpoint.'); if (endpoints.length > 1) result.push(endpoints.sort());
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function parseErc(text: string, exitCode: number): { diagnostics: KicadDiagnostic[]; verdict: 'pass' | 'fail' } {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail('KICAD_REPORT_LIMIT', 'ERC report exceeds 4 MiB.');
  let input: unknown; try { input = JSON.parse(text); } catch { return fail('KICAD_INVALID_REPORT', 'ERC did not produce a complete JSON report.'); }
  const report = input as { $schema?: string; kicad_version?: string; sheets?: { path?: string; violations?: { type?: string; severity?: string; description?: string }[] }[] };
  if (!report || report.$schema !== 'https://schemas.kicad.org/erc.v1.json' || report.kicad_version !== '10.0.8' || !Array.isArray(report.sheets)) fail('KICAD_INVALID_REPORT', 'Unsupported ERC JSON schema/version; expected the tested KiCad 10.0.8 per-sheet violations.');
  const diagnostics: KicadDiagnostic[] = [];
  for (const sheet of report.sheets!) {
    if (!Array.isArray(sheet.violations)) fail('KICAD_INVALID_REPORT', 'ERC sheet has no violation collection.');
    for (const violation of sheet.violations!) {
      if (!['error', 'warning', 'exclusion'].includes(violation.severity ?? '') || typeof violation.description !== 'string' || typeof violation.type !== 'string' || diagnostics.length >= 1000) fail('KICAD_INVALID_REPORT', 'Unsupported ERC severity, diagnostic shape or count.');
      diagnostics.push({ severity: violation.severity as KicadDiagnostic['severity'], code: violation.type!, message: violation.description!.slice(0, 2048), ...(typeof sheet.path === 'string' ? { sheetPath: sheet.path } : {}) });
    }
  }
  const findings = diagnostics.filter(item => item.severity !== 'exclusion').length;
  if (![0, 5].includes(exitCode) || exitCode === 0 && findings > 0 || exitCode === 5 && !diagnostics.length) fail('KICAD_INVALID_REPORT', 'ERC exit code and structured findings disagree. Retain logs and inspect native KiCad.');
  return { diagnostics, verdict: findings ? 'fail' : 'pass' };
}

/** KiCad plots contain only passive SVG geometry; reject active/URL-bearing markup. */
export function inertSvg(text: string): string {
  if (Buffer.byteLength(text) > 512 * 1024) fail('KICAD_PREVIEW_LIMIT', 'SVG exceeds the bounded preview size; use the native file.');
  const clean = text.replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE svg PUBLIC "-\/\/W3C\/\/DTD SVG 1\.1\/\/EN"\s+"http:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd">\s*/g, '');
  if (!/^\s*<svg\b[\s\S]*<\/svg>\s*$/.test(clean) || /<!|<\?|\b(?:href|src)\s*=|\bon[a-z]+\s*=|url\s*\(|@import|expression\s*\(|javascript:|data:|https?:\/\//i.test(clean.replace(/\sxmlns(?::[a-z]+)?="[^"]*"/g, ''))) fail('KICAD_UNSAFE_PREVIEW', 'SVG contains an active or external resource; open the native schematic instead.');
  const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'style', 'title', 'desc']);
  for (const tag of clean.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)/g)) if (!allowed.has(tag[1])) fail('KICAD_UNSAFE_PREVIEW', 'SVG contains an unsupported element.');
  return clean;
}
