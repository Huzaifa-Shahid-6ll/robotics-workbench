import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export type PinMode = 'input' | 'output' | 'analog-input' | 'pwm-output' | 'open-drain' | 'power' | 'ground' | 'passive' | 'bidirectional' | 'unknown';
export type ElectricalType = 'input' | 'output' | 'bidirectional' | 'open-drain' | 'power-in' | 'power-out' | 'ground' | 'passive' | 'unknown';
export interface FactSource {
  sourceId: string; uri: string; sha256: string | null; documentVersion: string; location: string;
  extractionMethod: 'manual' | 'manufacturer' | 'measured'; reviewStatus: 'reviewed' | 'candidate'; reviewedBy: string | null;
}
export interface NumericFact {
  value: number | null; unit: string; classification: 'recommended' | 'absolute-maximum' | 'typical' | 'measured' | 'estimate';
  conditions: string; applicability: string; sourceId: string; reviewStatus: 'reviewed' | 'candidate'; unknownReason: string | null;
  originalValue?: number | null; originalUnit?: string;
}
export interface NumericRange { minimum: NumericFact; maximum: NumericFact; minimumInclusive: boolean; maximumInclusive: boolean }
export interface LogicalPin {
  pinId: string; label: string; aliases: string[]; electricalType: ElectricalType; modes: PinMode[];
  required: boolean; sourceIds: string[]; voltageRange: NumericRange | null; driveVoltage: NumericFact | null;
  busKind: 'i2c' | 'spi' | 'uart' | null;
}
export interface ComponentDefinition {
  schemaVersion: 1; definitionId: string; definitionVersion: string; manufacturer: string; model: string; revision: string;
  package: string; classification: 'board' | 'ic' | 'module' | 'connector' | 'passive' | 'other';
  sources: FactSource[]; pins: LogicalPin[];
  /** Listed logical resources, not a positional physical-header drawing. */
  connectors: { connectorId: string; label: string; pinIds: string[] }[];
  facts: Record<string, NumericFact>;
}
const text = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const name = { ...text(256), pattern: '^[A-Za-z0-9+][A-Za-z0-9._:+-]*$' };
const review = { enum: ['reviewed', 'candidate'] };
const factSchema = object({ value: nullable({ type: 'number' }), unit: text(32), classification: { enum: ['recommended', 'absolute-maximum', 'typical', 'measured', 'estimate'] },
  conditions: text(2048), applicability: text(2048), sourceId: name, reviewStatus: review, unknownReason: nullable(text(2048)), originalValue: nullable({ type: 'number' }), originalUnit: text(32) },
['value', 'unit', 'classification', 'conditions', 'applicability', 'sourceId', 'reviewStatus', 'unknownReason']);
const sourceSchema = object({ sourceId: name, uri: { ...text(4096), format: 'uri' }, sha256: nullable({ type: 'string', pattern: '^[a-f0-9]{64}$' }), documentVersion: text(256), location: text(1024), extractionMethod: { enum: ['manual', 'manufacturer', 'measured'] }, reviewStatus: review, reviewedBy: nullable(text(256)) });
const rangeSchema = object({ minimum: factSchema, maximum: factSchema, minimumInclusive: { type: 'boolean' }, maximumInclusive: { type: 'boolean' } });
const pinSchema = object({ pinId: name, label: text(256), aliases: { type: 'array', maxItems: 64, uniqueItems: true, items: name }, electricalType: { enum: ['input', 'output', 'bidirectional', 'open-drain', 'power-in', 'power-out', 'ground', 'passive', 'unknown'] },
  modes: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { enum: ['input', 'output', 'analog-input', 'pwm-output', 'open-drain', 'power', 'ground', 'passive', 'bidirectional', 'unknown'] } }, required: { type: 'boolean' },
  sourceIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: name }, voltageRange: nullable(rangeSchema), driveVoltage: nullable(factSchema), busKind: { enum: ['i2c', 'spi', 'uart', null] } });
const definitionSchema = object({ schemaVersion: { const: 1 }, definitionId: name, definitionVersion: text(64), manufacturer: text(256), model: text(256), revision: text(256), package: text(256), classification: { enum: ['board', 'ic', 'module', 'connector', 'passive', 'other'] },
  sources: { type: 'array', minItems: 1, maxItems: 32, items: sourceSchema }, pins: { type: 'array', minItems: 1, maxItems: 256, items: pinSchema }, connectors: { type: 'array', maxItems: 64, items: object({ connectorId: name, label: text(256), pinIds: { type: 'array', minItems: 1, maxItems: 256, items: name } }) },
  facts: { type: 'object', maxProperties: 100, propertyNames: name, additionalProperties: factSchema } });
const ajv = new Ajv({ strict: true, ownProperties: true }); addFormats(ajv);
const definition = ajv.compile<ComponentDefinition>(definitionSchema), fact = ajv.compile<NumericFact>(factSchema);
function bounded(value: unknown): boolean { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512 * 1024; } catch { return false; } }
export function isComponentDefinition(value: unknown): value is ComponentDefinition { return bounded(value) && definition(value); }
export function isNumericFact(value: unknown): value is NumericFact { return bounded(value) && fact(value); }
