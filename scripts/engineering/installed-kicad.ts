import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { CompanionClient } from '../../apps/extension/src/companion-client';
import type { KicadSnapshot, OperationReceipt } from '@robotics-workbench/contracts';

async function main() {
  const runId=randomUUID(), directory=resolve(`verification/evidence/task-10/installed-kicad/${runId}`);
  const work=resolve(`artifacts/task10-installed-kicad/${runId}`), root=join(work,'project'), dataRoot=join(work,'data');
  mkdirSync(directory,{recursive:true}); mkdirSync(work,{recursive:true});
  const seeded=JSON.parse(execFileSync(process.execPath,[resolve('artifacts/task10-seed.cjs'),root,dataRoot],{encoding:'utf8',windowsHide:true}));
  const installed=readdirSync('.vscode-test/installed-extensions').filter(name=>name.startsWith('local-workbench.robotics-workbench-0.1.0')); assert.equal(installed.length,1);
  const script=resolve('.vscode-test/installed-extensions',installed[0],'dist/companion.js');
  assert.deepEqual(readFileSync(script),readFileSync('apps/extension/dist/companion.js'));
  const client=new CompanionClient(script,process.execPath,()=>{},()=>{},{projectRoot:root,dataRoot,kicadPath:resolve('artifacts/task10-tools/kicad/bin/kicad-cli.exe'),kicadSha256:'852a4dea194f72a2293a7f8ea000c386074939efe61d8dcd2c25bfb32bf228d9'});
  const request=(method:'kicad.snapshot'|'kicad.generate'|'operation.get',params:Record<string,unknown>={})=>client.requestProject({schemaVersion:1,projectId:seeded.projectId,requestId:randomUUID(),method,params,expectedProjectRevision:1});
  try {
    const snapshot=await request('kicad.snapshot') as KicadSnapshot; assert.equal(snapshot.readiness.available,true,JSON.stringify(snapshot.readiness)); assert.equal(snapshot.readiness.capability?.version,'10.0.8');
    let receipt=await request('kicad.generate',{mappingPath:seeded.mappingPath,expectedManifestSha256:snapshot.manifestSha256}) as OperationReceipt;
    const deadline=Date.now()+120000;
    while(['queued','running','awaiting-input'].includes(receipt.status)&&Date.now()<deadline) {await new Promise(resolve=>setTimeout(resolve,100));receipt=await request('operation.get',{operationId:receipt.operationId}) as OperationReceipt;}
    assert.equal(receipt.status,'succeeded',JSON.stringify(receipt)); assert.equal(receipt.result?.netlistEquivalent,true); assert.equal(receipt.result?.verdict,'pass');
    const report={schemaVersion:1,runId,status:'passed',evidenceClass:'installed-windows-native-cli',companionSha256:createHash('sha256').update(readFileSync(script)).digest('hex'),capability:snapshot.readiness.capability,receipt,limitations:['Uses actual installed VSIX companion and its scoped child environment; no native GUI editing or physical verification.']};
    writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n'); console.log(directory);
  } finally {await client.stop();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
