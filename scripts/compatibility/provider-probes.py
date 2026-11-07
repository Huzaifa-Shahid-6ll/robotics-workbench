"""Local protocol probes only. No model task, login flow, credential-file read or board access."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT/'artifacts/compatibility'

def read_lines(stream, messages):
    for line in stream:
        messages.put(line)

def finish(process):
    if process.stdin:
        process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=5)
    assert process.poll() is not None, 'Owned provider process did not exit'

def codex_probe(executable):
    bundle_path = DESTINATION/'codex-schema/codex_app_server_protocol.schemas.json'
    bundle = json.loads(bundle_path.read_text(encoding='utf-8'))
    schema = {'$ref': '#/definitions/InitializeResponse', 'definitions': bundle['definitions']}
    process = subprocess.Popen([executable, 'app-server', '--stdio'], cwd=DESTINATION/'scratch', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
    messages = queue.Queue()
    threading.Thread(target=read_lines, args=(process.stdout, messages), daemon=True).start()
    def request(identifier, method, params):
        process.stdin.write(json.dumps({'id': identifier, 'method': method, 'params': params})+'\n')
        process.stdin.flush()
        deadline = time.monotonic()+20
        while time.monotonic() < deadline:
            message = json.loads(messages.get(timeout=max(0.1, deadline-time.monotonic())))
            if message.get('id') == identifier:
                assert 'error' not in message, f'{method} rejected; no task submitted'
                return message['result']
        raise TimeoutError(method)
    try:
        initialized = request(1, 'initialize', {'clientInfo': {'name': 'robotics_workbench_compatibility', 'version': '0.1.0'}, 'capabilities': {'experimentalApi': False}})
        Draft7Validator(schema).validate(initialized)
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        account = request(2, 'account/read', {'refreshToken': False})
        Draft7Validator(json.loads((DESTINATION/'codex-schema/v2/GetAccountResponse.json').read_text())).validate(account)
        result = {'handshake': 'passed', 'platformOs': initialized['platformOs'], 'schemaSha256': hashlib.sha256(bundle_path.read_bytes()).hexdigest(), 'authentication': 'present' if account.get('account') else 'not-present', 'accountType': (account.get('account') or {}).get('type'), 'requiresOpenaiAuth': account['requiresOpenaiAuth'], 'turnSubmitted': False, 'cancelReconnect': 'not-run'}
    finally:
        finish(process)
    result['processExitObserved'] = True
    return result

def opencode_probe(executable):
    password = os.urandom(32).hex()
    env = dict(os.environ, OPENCODE_SERVER_PASSWORD=password, OPENCODE_SERVER_USERNAME='opencode')
    process = subprocess.Popen([executable, 'serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'], cwd=DESTINATION/'scratch', env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
    messages = queue.Queue()
    threading.Thread(target=read_lines, args=(process.stdout, messages), daemon=True).start()
    try:
        deadline = time.monotonic()+30
        endpoint = None
        while time.monotonic() < deadline:
            line = messages.get(timeout=max(0.1, deadline-time.monotonic()))
            match = re.search(r'http://127\.0\.0\.1:\d+', line)
            if match:
                endpoint = match.group(0)
                break
        assert endpoint, 'Loopback server startup was not observed'
        try:
            urllib.request.urlopen(endpoint+'/global/health', timeout=5)
            raise AssertionError('Unauthenticated health unexpectedly accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        headers = {'Authorization': 'Basic '+base64.b64encode(('opencode:'+password).encode()).decode()}
        def get(path):
            with urllib.request.urlopen(urllib.request.Request(endpoint+path, headers=headers), timeout=10) as response:
                return json.load(response)
        health = get('/global/health')
        assert health.get('healthy') is True
        specification = get('/doc')
        assert specification.get('openapi') and '/session' in specification['paths']
        encoded = json.dumps(specification, sort_keys=True).encode()
        (DESTINATION/'opencode-openapi.json').write_bytes(encoded)
        result = {'health': health, 'unauthenticatedStatus': 401, 'openapiSha256': hashlib.sha256(encoded).hexdigest(), 'turnSubmitted': False, 'cancelReconnect': 'not-run', 'plugins': 'disabled for bounded protocol probe; normal plugin compatibility unverified'}
    finally:
        finish(process)
    result['processExitObserved'] = True
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', required=True)
    parser.add_argument('--opencode', required=True)
    args = parser.parse_args()
    (DESTINATION/'scratch').mkdir(parents=True, exist_ok=True)
    record = {}
    for name, executable, probe in [('codex', args.codex, codex_probe), ('opencode', args.opencode, opencode_probe)]:
        assert Path(executable).is_absolute() and Path(executable).is_file()
        try:
            record[name] = {'executablePath': executable, **probe(executable)}
        except Exception as error:
            record[name] = {'executablePath': executable, 'result': 'failed', 'errorType': type(error).__name__, 'limitation': 'No model task was submitted; inspect protocol/version before continuing.'}
    (DESTINATION/'providers.json').write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(record, indent=2))
    assert all('result' not in value for value in record.values()), 'A provider protocol probe failed'

if __name__ == '__main__':
    main()
