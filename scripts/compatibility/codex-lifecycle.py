"""Explicit Codex compatibility probe; never part of ordinary software verification."""
import argparse
import hashlib
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT/'artifacts/compatibility/lifecycle'
SCHEMAS = ROOT/'artifacts/compatibility/codex-schema'

class Rpc:
    def __init__(self, executable, scratch):
        self.process = subprocess.Popen([str(executable), 'app-server', '--stdio'], cwd=scratch, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
        self.messages = queue.Queue()
        self.events = []
        self.sequence = 0
        self.trace = []
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                self.messages.put({'protocolError': True})
        self.messages.put({'disconnected': True})

    def receive(self, timeout):
        message = self.messages.get(timeout=timeout)
        assert not message.get('protocolError'), 'Malformed protocol stdout'
        assert not message.get('disconnected'), 'Provider disconnected'
        if 'method' in message:
            self.trace.append({'method': message['method'], 'turnId': message.get('params', {}).get('turnId')})
            if 'id' in message:
                raise AssertionError('Unexpected permission/tool request in text-only probe; no approval sent')
        return message

    def notify(self, method):
        self.process.stdin.write(json.dumps({'method': method})+'\n')
        self.process.stdin.flush()

    def request(self, method, params, params_schema, result_schema=None):
        Draft7Validator(json.loads((SCHEMAS/'v2'/f'{params_schema}.json').read_text())).validate(params)
        self.sequence += 1
        identifier = self.sequence
        self.process.stdin.write(json.dumps({'id': identifier, 'method': method, 'params': params})+'\n')
        self.process.stdin.flush()
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            message = self.receive(max(0.1, deadline-time.monotonic()))
            if message.get('id') == identifier:
                if 'error' in message:
                    raise RuntimeError(f'{method} rejected with code {message["error"].get("code")}: {str(message["error"].get("message", ""))[:160]}')
                result = message['result']
                if result_schema:
                    Draft7Validator(json.loads((SCHEMAS/'v2'/f'{result_schema}.json').read_text())).validate(result)
                return result
            self.events.append(message)
        raise TimeoutError(method)

    def initialize(self):
        self.sequence += 1
        identifier = self.sequence
        self.process.stdin.write(json.dumps({'id': identifier, 'method': 'initialize', 'params': {'clientInfo': {'name': 'robotics_workbench_compatibility', 'version': '0.1.0'}, 'capabilities': {'experimentalApi': False}}})+'\n')
        self.process.stdin.flush()
        message = self.receive(20)
        assert message.get('id') == identifier and 'result' in message
        bundle = json.loads((SCHEMAS/'codex_app_server_protocol.schemas.json').read_text())
        Draft7Validator({'$ref': '#/definitions/InitializeResponse', 'definitions': bundle['definitions']}).validate(message['result'])
        self.notify('initialized')

    def terminal(self, turn_id):
        deadline = time.monotonic()+120
        while time.monotonic() < deadline:
            message = self.events.pop(0) if self.events else self.receive(max(0.1, deadline-time.monotonic()))
            if message.get('method') == 'turn/completed' and message['params']['turn']['id'] == turn_id:
                return message['params']['turn']
        raise TimeoutError('turn/completed')

    def started(self, turn_id):
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            message = self.events.pop(0) if self.events else self.receive(max(0.1, deadline-time.monotonic()))
            if message.get('method') == 'turn/started' and message['params']['turn']['id'] == turn_id:
                return
        raise TimeoutError('turn/started')

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        assert self.process.poll() is not None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True, type=Path)
    parser.add_argument('--live', action='store_true', help='Submit bounded text-only turns through the configured provider-managed route')
    args = parser.parse_args()
    assert args.executable.is_absolute() and args.executable.is_file()
    scratch = DESTINATION/'Codex scratch space'
    scratch.mkdir(parents=True, exist_ok=True)
    started = time.time()
    record = {'gateId': 'VG-02', 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(started)), 'executablePath': str(args.executable), 'version': subprocess.check_output([str(args.executable), '--version'], text=True).strip(), 'liveRequested': args.live, 'commands': [], 'turnsSubmitted': 0}
    rpc = Rpc(args.executable, scratch)
    try:
        rpc.initialize()
        account = rpc.request('account/read', {'refreshToken': False}, 'GetAccountParams', 'GetAccountResponse')
        config = rpc.request('config/read', {'includeLayers': False, 'cwd': str(scratch)}, 'ConfigReadParams', 'ConfigReadResponse')['config']
        record['route'] = {'accountType': (account.get('account') or {}).get('type'), 'model': config.get('model'), 'modelProvider': config.get('model_provider')}
        if not args.live:
            record['disposition'] = 'not-run'
        else:
            assert account.get('account'), 'Provider-managed login required'
            assert record['route']['model'], 'No configured model; choose a route before submitting'
            print('Using existing Codex route: '+json.dumps(record['route']), flush=True)
            thread = rpc.request('thread/start', {'cwd': str(scratch), 'model': record['route']['model'], 'approvalPolicy': 'never', 'sandbox': 'read-only', 'developerInstructions': 'This is a text-only compatibility test. Do not use tools, read files, run commands or access hardware. Follow the user text exactly.'}, 'ThreadStartParams', 'ThreadStartResponse')
            thread_id = thread['thread']['id']
            record['route']['effectiveModel'] = thread.get('model')
            record['route']['effectiveProvider'] = thread.get('modelProvider')
            turn = rpc.request('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'Reply with exactly WORKBENCH_COMPAT_OK. Do not use any tools.'}]}, 'TurnStartParams', 'TurnStartResponse')['turn']
            record['turnsSubmitted'] += 1
            terminal = rpc.terminal(turn['id'])
            record['completedTurnStatus'] = terminal['status']
            assert terminal['status'] == 'completed', 'Text-only inference did not complete'
            assert any(item.get('type') == 'agentMessage' and 'WORKBENCH_COMPAT_OK' in item.get('text', '') for item in terminal.get('items', [])), 'Missing attributable answer'
            interrupted = rpc.request('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'Write the numbers 1 to 1000, one per line. Do not use tools.'}]}, 'TurnStartParams', 'TurnStartResponse')['turn']
            record['turnsSubmitted'] += 1
            record['turnIds'] = [turn['id'], interrupted['id']]
            rpc.started(interrupted['id'])
            rpc.request('turn/interrupt', {'threadId': thread_id, 'turnId': interrupted['id']}, 'TurnInterruptParams', 'TurnInterruptResponse')
            cancellation = rpc.terminal(interrupted['id'])
            record['interruptedTurnStatus'] = cancellation['status']
            assert cancellation['status'] == 'interrupted'
            record['sessionId'] = thread_id
            record['traceBeforeDisconnect'] = rpc.trace
            rpc.close()
            rpc = Rpc(args.executable, scratch)
            rpc.initialize()
            resumed = rpc.request('thread/resume', {'threadId': thread_id, 'cwd': str(scratch), 'approvalPolicy': 'never', 'sandbox': 'read-only'}, 'ThreadResumeParams', 'ThreadResumeResponse')
            assert resumed['thread']['id'] == thread_id
            record['resumedTurnIds'] = [item['id'] for item in resumed['thread']['turns']]
            assert turn['id'] in record['resumedTurnIds'] and interrupted['id'] in record['resumedTurnIds']
            assert len(record['resumedTurnIds']) == 2, 'Reconnect must not submit or duplicate a turn'
            record['disposition'] = 'passed'
    except Exception as error:
        record['disposition'] = 'failed'
        record['errorType'] = type(error).__name__
        record['error'] = str(error)[:250] if isinstance(error, (AssertionError, RuntimeError, TimeoutError)) else 'Protocol/schema validation failed; raw private payload omitted.'
    finally:
        rpc.close()
        record['traceAfterReconnect'] = rpc.trace
        record['processExitObserved'] = True
        record['endedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        record['schemaSha256'] = hashlib.sha256((SCHEMAS/'codex_app_server_protocol.schemas.json').read_bytes()).hexdigest()
        (DESTINATION/'codex.json').write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(record, indent=2))
    assert record['disposition'] != 'failed', 'Codex compatibility did not pass; see safe report'

if __name__ == '__main__':
    main()
