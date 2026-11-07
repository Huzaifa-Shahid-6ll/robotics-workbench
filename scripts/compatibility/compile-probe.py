"""Compile a synthetic fixture using an existing CLI/core; never discover or open a port."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', required=True, type=Path)
    parser.add_argument('--existing-sketch', type=Path, help='Read-only external sketch folder; compile a project-local copy')
    parser.add_argument('--fqbn', default='arduino:avr:uno')
    args = parser.parse_args()
    started_at = datetime.now(timezone.utc).isoformat()
    assert args.cli.is_absolute() and args.cli.is_file()
    fixture = ROOT/'packages/test-fixtures/compatibility/CompileProbe'
    destination = ROOT/'artifacts/compatibility/arduino'
    original = None
    original_hashes = None
    if args.existing_sketch:
        original = args.existing_sketch.resolve(strict=True)
        assert original.is_dir() and (original/f'{original.name}.ino').is_file(), 'Ordinary matching sketch folder/primary file required'
        assert all(not path.is_symlink() for path in original.rglob('*')), 'Symlinks require a separately scoped source-copy policy'
        original_hashes = {path.relative_to(original).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in original.rglob('*') if path.is_file()}
        destination = ROOT/'artifacts/compatibility/arduino-existing'/str(uuid.uuid4())
        fixture = destination/'source'/original.name
        shutil.copytree(original, fixture)
    destination.mkdir(parents=True, exist_ok=True)
    source = fixture/f'{fixture.name}.ino'
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    command = [str(args.cli), 'compile', '--fqbn', args.fqbn, '--build-path', str(destination/'build'), '--output-dir', str(destination/'output')]
    if original:
        command.append('--verbose')
    command.append(str(fixture))
    assert not {'--upload', '-u', '--port', '-p'} & set(command)
    temporary = destination/'tmp'
    temporary.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, ARDUINO_BUILD_CACHE_PATH=str(destination/'cache'), TEMP=str(temporary), TMP=str(temporary))
    completed = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    (destination/'compile.log').write_text(completed.stdout+'\n'+completed.stderr, encoding='utf-8')
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before, 'Compile changed source'
    if original:
        after = {path.relative_to(original).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in original.rglob('*') if path.is_file()}
        copied = {path.relative_to(fixture).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in fixture.rglob('*') if path.is_file()}
        assert original_hashes == after == copied, 'Original/copy hashes must remain identical'
    artifacts = [{'path': str(path.relative_to(ROOT)), 'sizeBytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in (destination/'output').glob('*') if path.is_file()]
    result = {'command': command, 'exitCode': completed.returncode, 'fixture': 'pre-existing external sketch copy' if original else 'synthetic compile only', 'sourceSha256BeforeAndAfter': before, 'hardwareTested': False, 'artifacts': artifacts}
    if original:
        result.update({'gateId': 'VG-05', 'originalPath': str(original), 'originalAndCopyFiles': original_hashes,
                       'originalPreserved': True, 'fqbn': args.fqbn,
                       'cliVersion': subprocess.check_output([str(args.cli), 'version'], text=True).strip()})
        options = destination/'build/build.options.json'
        if options.is_file():
            result['resolvedBuildOptions'] = json.loads(options.read_text())
        cores = json.loads(subprocess.check_output([str(args.cli), 'core', 'list', '--json'], text=True))
        result['installedCores'] = [{'id': item['id'], 'installedVersion': item['installed_version']} for item in cores['platforms'] if item.get('installed_version')]
        result['effectiveDirectories'] = {name: subprocess.check_output([str(args.cli), 'config', 'get', 'directories.'+name], text=True).strip() for name in ['data', 'user']}
    result.update({'startedAt': started_at, 'endedAt': datetime.now(timezone.utc).isoformat()})
    (destination/'result.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    assert completed.returncode == 0, 'Compile failed; see artifacts/compatibility/arduino/compile.log'
    assert any(item['path'].endswith('.hex') and item['sizeBytes'] > 0 for item in artifacts)
    if original:
        (ROOT/'artifacts/compatibility/arduino-existing/latest.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
        print('Existing sketch copy compile passed; original preserved; no board accessed.')
    else:
        print('Synthetic Uno compile passed; source unchanged; no board accessed.')

if __name__ == '__main__':
    main()
