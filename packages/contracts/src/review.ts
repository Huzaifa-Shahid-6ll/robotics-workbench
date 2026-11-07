import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

interface ReviewHostState { version: number; dirty: boolean; textSha256: string }
export interface ReviewSnapshotV1 {
  schemaVersion: 1; taskId: string; root: string;
  files: { id: string; path: string; baselineText: string | null; baselineSha256: string | null; baselineHost: ReviewHostState | null;
    observedText?: string | null; observedSha256?: string | null; observedHost?: ReviewHostState | null; proposedText?: string;
    effect: 'proposed' | 'written' | 'conflicted' | 'kept' | 'reverted'; conflict: string | null }[];
  omitted: { id: string; path: string; reason: string }[];
}
const text = (maxLength: number) => ({ type: 'string', maxLength });
const id = { type: 'string', format: 'uuid' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const host = nullable(object({ version: { type: 'integer', minimum: 1 }, dirty: { type: 'boolean' }, textSha256: hash }));
const schema = object({ schemaVersion: { const: 1 }, taskId: id, root: { ...text(4096), minLength: 1 },
  files: { type: 'array', maxItems: 256, items: object({ id, path: { ...text(4096), minLength: 1 }, baselineText: nullable(text(131072)), baselineSha256: nullable(hash), baselineHost: host, observedText: nullable(text(131072)), observedSha256: nullable(hash), observedHost: host, proposedText: text(131072), effect: { enum: ['proposed', 'written', 'conflicted', 'kept', 'reverted'] }, conflict: nullable(text(2048)) }, ['id', 'path', 'baselineText', 'baselineSha256', 'baselineHost', 'effect', 'conflict']) },
  omitted: { type: 'array', maxItems: 100, items: object({ id, path: text(4096), reason: text(2048) }) }
});
const ajv = new Ajv({ strict: true }); addFormats(ajv);
const validate = ajv.compile<ReviewSnapshotV1>(schema);
export function isReviewSnapshot(value: unknown): value is ReviewSnapshotV1 {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512 * 1024 && validate(value); } catch { return false; }
}
