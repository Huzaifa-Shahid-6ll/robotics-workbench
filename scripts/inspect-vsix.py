"""Inspect exact VSIX contents against an allowlist without extracting files."""
import hashlib
import json
from pathlib import Path
import sys
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 2000

def inspect(path):
    path = Path(path)
    assert path.stat().st_size <= MAX_ARCHIVE_BYTES, 'VSIX compressed size exceeds inspection bound'
    allowed = {'[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/readme.md', 'extension/README.md', 'extension/license.txt', 'extension/LICENSE.txt', 'extension/media/robotics.svg', 'extension/dist/extension.js', 'extension/dist/companion.js', 'extension/dist/THIRD-PARTY-NOTICES.txt'}
    allowed.update('extension/dist/schemas/'+item.name for item in (ROOT/'contracts').glob('*.schema.json'))
    allowed.add('extension/dist/mcp-stdio.js')
    assets = ['dist/agent.js', 'dist/agent.css', 'dist/wiring.js', 'dist/wiring.css', 'dist/documents.js', 'dist/documents.css', 'dist/documents-worker.cjs', 'dist/telemetry.js', 'dist/telemetry.css', 'dist/telemetry-worker.cjs']
    assets.extend(['dist/engineering.js', 'dist/engineering.css', 'dist/cad-runner.py'])
    allowed.update('extension/'+name for name in assets)
    native_path = ROOT/'apps/extension/dist/native-runtime.json'
    native = json.loads(native_path.read_text(encoding='utf-8'))
    assert native['schemaVersion'] == 1 and native['target'] == 'win32-x64'
    native_files = {item['path']: item for item in native['files']}
    assert len(native_files) == len(native['files']), 'Duplicate native inventory files'
    binary = 'vendor/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node'
    assert binary in native_files, 'Missing native Windows x64 prebuild'
    for name in native_files:
        assert name.startswith('vendor/node_modules/') and '..' not in name.split('/') and '\\' not in name
        assert not name.endswith('.node') or name in [binary, 'vendor/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node'], 'Unexpected native binary/platform'
    allowed.add('extension/dist/native-runtime.json')
    allowed.update('extension/dist/'+name for name in native_files)
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        assert len(entries) <= MAX_ENTRIES, 'VSIX entry count exceeds inspection bound'
        assert sum(item.file_size for item in entries) <= MAX_EXPANDED_BYTES, 'VSIX expanded size exceeds inspection bound'
        for item in entries:
            assert item.file_size <= MAX_ENTRY_BYTES, 'VSIX entry size exceeds inspection bound'
            assert not item.flag_bits & 1, 'Encrypted VSIX entries are not supported'
            assert stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), 'Non-regular VSIX entries are not supported'
        names = set(archive.namelist())
        assert len(names) == len(archive.namelist()), 'Duplicate ZIP entries'
        assert names <= allowed, f'Unexpected package contents: {names-allowed}'
        for required in ['extension/package.json', 'extension/dist/extension.js', 'extension/dist/companion.js', 'extension/dist/THIRD-PARTY-NOTICES.txt', 'extension/dist/schemas/companion-control.schema.json']:
            assert required in names, f'Missing {required}'
        for relative in ['dist/extension.js', 'dist/companion.js', 'dist/mcp-stdio.js', *assets]:
            assert archive.read('extension/'+relative) == (ROOT/'apps/extension'/relative).read_bytes()
        assert archive.read('extension/dist/native-runtime.json') == native_path.read_bytes()
        for name, item in native_files.items():
            data = archive.read('extension/dist/'+name)
            assert len(data) == item['sizeBytes'] and hashlib.sha256(data).hexdigest() == item['sha256'], f'Native asset hash mismatch: {name}'
            assert data == (ROOT/'apps/extension/dist'/name).read_bytes(), f'Native asset differs from build: {name}'
        for pkg in native['packages']:
            assert pkg['licensePath'] in native_files, f'Missing native license: {pkg["name"]}'
        manifest = json.loads(archive.read('extension/package.json'))
        assert manifest['main'] == './dist/extension.js'
        assert manifest['capabilities']['untrustedWorkspaces']['supported'] == 'limited'
        return {'passed': True, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'files': sorted(names), 'nativeBinarySha256': native_files[binary]['sha256'], 'nativePackages': native['packages'], 'inspection': 'Exact contents allowlist; entry points and all native runtime files byte-match built outputs and SHA inventory. Windows x64 prebuild only. No runtime secrets or user data supplied to bundler.'}

def self_test():
    import tempfile
    import struct
    import unittest
    from unittest.mock import patch

    class InspectionFailures(unittest.TestCase):
        def setUp(self):
            global ROOT
            self.previous_root = ROOT
            parent = ROOT / 'artifacts'
            parent.mkdir(exist_ok=True)
            self.temp = tempfile.TemporaryDirectory(prefix='vsix-inspector-', dir=parent)
            ROOT = Path(self.temp.name)
            assert ROOT.resolve().is_relative_to(parent.resolve())
            native_path = ROOT / 'apps/extension/dist/native-runtime.json'
            native_path.parent.mkdir(parents=True)
            binary = 'vendor/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node'
            native_path.write_text(json.dumps({'schemaVersion': 1, 'target': 'win32-x64', 'files': [{'path': binary}], 'packages': []}), encoding='utf-8')

        def tearDown(self):
            global ROOT
            assert Path(self.temp.name).resolve().is_relative_to((self.previous_root / 'artifacts').resolve())
            ROOT = self.previous_root
            self.temp.cleanup()

        def fixture(self, names, claimed_size=None, mode=None, encrypted=False):
            target = ROOT / 'fixture.vsix'
            with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name in names:
                    item = zipfile.ZipInfo(name)
                    item.compress_type = zipfile.ZIP_DEFLATED
                    if mode is not None:
                        item.external_attr = mode << 16
                    archive.writestr(item, b'a')
            data = bytearray(target.read_bytes())
            offset = data.find(b'PK\x01\x02')
            while offset >= 0:
                if claimed_size is not None:
                    struct.pack_into('<I', data, offset + 24, claimed_size)
                if encrypted:
                    struct.pack_into('<H', data, offset + 8, 1)
                offset = data.find(b'PK\x01\x02', offset + 46)
            target.write_bytes(data)
            return target

        def reject_before_read(self, target, reason):
            with patch.object(zipfile.ZipFile, 'read', side_effect=AssertionError('DECOMPRESSION BEFORE PREFLIGHT')):
                with self.assertRaisesRegex(AssertionError, reason):
                    inspect(target)

        def test_compressed_size(self):
            target = self.fixture(['extension/dist/extension.js'])
            with patch.object(Path, 'stat', return_value=type('Size', (), {'st_size': MAX_ARCHIVE_BYTES + 1})()):
                self.reject_before_read(target, 'compressed size')

        def test_single_entry_bomb(self):
            self.reject_before_read(self.fixture(['extension/dist/extension.js'], MAX_ENTRY_BYTES + 1), 'entry size')

        def test_total_expansion(self):
            self.reject_before_read(self.fixture([f'entry{i}' for i in range(5)], MAX_ENTRY_BYTES), 'expanded size')

        def test_entry_count(self):
            self.reject_before_read(self.fixture([f'entry{i}' for i in range(MAX_ENTRIES + 1)]), 'entry count')

        def test_encrypted_and_link_entries(self):
            self.reject_before_read(self.fixture(['extension/readme.md'], encrypted=True), 'Encrypted')
            self.reject_before_read(self.fixture(['extension/readme.md'], mode=stat.S_IFLNK | 0o777), 'Non-regular')

        def test_private_payload_paths(self):
            for name in ['extension/auth.json', 'extension/capture.jsonl', 'extension/Sketch.ino']:
                self.reject_before_read(self.fixture([name]), 'Unexpected package contents')

        def test_missing_runtime(self):
            self.reject_before_read(self.fixture([]), 'Missing')

    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(InspectionFailures))
    if not result.wasSuccessful():
        raise SystemExit(1)


if __name__ == '__main__' and sys.argv[1:] == ['--self-test']:
    self_test()
elif __name__ == '__main__':
    result = inspect(Path(sys.argv[1]))
    (ROOT/'artifacts/package-inspection.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(f"VSIX inspection passed: {len(result['files'])} allowed files.")
