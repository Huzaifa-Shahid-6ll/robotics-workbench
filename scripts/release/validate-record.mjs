import { realpathSync } from 'node:fs';
import { json, releaseContext, validateReleaseRecord } from './release-record.mjs';

try {
  if (process.argv.length !== 3) throw Error('Expected one repository-relative release.json path.');
  const root = realpathSync('.'), record = json(root, process.argv[2]);
  const errors = validateReleaseRecord(record, releaseContext(root, record.vsix?.path));
  console.log(JSON.stringify({ testId: 'release.acceptance', result: errors.length ? 'blocked' : 'passed', accepted: false, errors,
    scope: 'Artifact/source/requirement/metadata/class verification only; no publication or automatic acceptance.' }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) { console.error(`Release validation failed: ${error.message}`); process.exitCode = 1; }
