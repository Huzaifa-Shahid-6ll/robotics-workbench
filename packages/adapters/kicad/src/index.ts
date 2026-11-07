import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { WorkbenchError, type KicadCapability } from '@robotics-workbench/contracts';
import type { ProcessResult, ProcessSpec } from '@robotics-workbench/application';
import { digest, KICAD_FORMAT } from './native';
export * from './native';
export const KICAD_TESTED_VERSION = '10.0.8';
export const KICAD_TESTED_EXECUTABLE_SHA256 = '852a4dea194f72a2293a7f8ea000c386074939efe61d8dcd2c25bfb32bf228d9';
export interface KicadConfig { executable?: string; testedExecutableSha256?: string }
export type KicadRunner = { run(spec: ProcessSpec): Promise<ProcessResult> };
export const kicadEnvironmentSha256 = (): string => digest(JSON.stringify({ LC_ALL: 'C', LANG: 'C', PATH: process.env.PATH ?? process.env.Path ?? '', APPDATA: process.env.APPDATA ?? '', LOCALAPPDATA: process.env.LOCALAPPDATA ?? '' }));
export async function inspectKicad(runner: KicadRunner, config: KicadConfig, cwd: string, signal?: AbortSignal): Promise<KicadCapability> {
  if (!config.executable || !isAbsolute(config.executable)) throw new WorkbenchError('TOOL_UNAVAILABLE', 'Configure an absolute local kicad-cli executable. Other project features remain available.');
  let actualHash: string;
  try { if (!statSync(config.executable).isFile()) throw new Error(); actualHash = digest(readFileSync(config.executable)); } catch { throw new WorkbenchError('TOOL_UNAVAILABLE', 'Configured kicad-cli is missing or unreadable.'); }
  if (actualHash !== (config.testedExecutableSha256 ?? KICAD_TESTED_EXECUTABLE_SHA256)) throw new WorkbenchError('KICAD_UNTESTED_EXECUTABLE', 'KiCad executable fingerprint differs from the real-fixture compatibility receipt. Validate this exact installation before enabling generation.');
  const results: string[] = [];
  for (const args of [['--version'], ['sch', 'erc', '--help'], ['sch', 'export', 'netlist', '--help'], ['sch', 'export', 'svg', '--help']]) {
    const result = await runner.run({ executable: config.executable, args, cwd, signal, timeoutMs: 15000, maxOutputBytes: 65536, env: { LC_ALL: 'C', LANG: 'C' } });
    assertKicadProcess(result); results.push(result.stdout);
  }
  const version = results[0].trim();
  if (version !== KICAD_TESTED_VERSION) throw new WorkbenchError('KICAD_UNSUPPORTED_VERSION', `Only fixture-tested KiCad ${KICAD_TESTED_VERSION} is enabled; found ${version}. No file was converted.`);
  if (!['--format', 'json', '--exit-code-violations', '--severity-all'].every(flag => results[1].includes(flag)) || !results[2].includes('kicadxml') || !results[3].includes('--output')) throw new WorkbenchError('KICAD_UNSUPPORTED_CAPABILITY', 'Installed command help lacks the tested ERC JSON, native netlist or per-sheet SVG interface.');
  return { executable: config.executable, executableSha256: actualHash, version, formatVersion: KICAD_FORMAT, helpSha256: digest(results.slice(1).join('\n')), environmentSha256: kicadEnvironmentSha256(), libraryPaths: ['project:sym-lib-table', 'project:Workbench.kicad_sym', 'embedded:lib_symbols'] };
}
export function assertKicadProcess(result: ProcessResult, allowedExitCodes = [0]): void {
  if (result.cancelled) throw new WorkbenchError('CANCELLED', 'KiCad process cancellation was observed; last good artifacts remain available.');
  if (result.timedOut) throw new WorkbenchError('KICAD_TIMEOUT', 'KiCad exceeded its deadline; source and last good artifacts were preserved.');
  if (!result.terminationObserved) throw new WorkbenchError('OUTCOME_UNKNOWN', 'KiCad termination was not observed.');
  if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode) || result.stdoutTruncated || result.stderrTruncated || result.logsTruncated) throw new WorkbenchError('KICAD_EXECUTION_FAILED', 'KiCad did not complete the tested command. Inspect the retained bounded process logs.');
}
