import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { WorkbenchError } from '@robotics-workbench/contracts';
import { canonicalTransportPath, type SerialConnection, type SerialOptions, type SerialTransport } from '@robotics-workbench/devices';

export interface NativePort {
  readonly isOpen: boolean;
  read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }>;
  close(): Promise<void>;
}
export interface NativeBinding { open(options: SerialOptions): Promise<NativePort> }

/** The production composition root supplies its installed, extension-owned package path. */
export class NativeSerialTransport implements SerialTransport {
  private binding?: NativeBinding;
  constructor(private readonly bindingPackagePath?: string, private readonly bindingFactory?: () => NativeBinding) {
    if (bindingPackagePath !== undefined && !isAbsolute(bindingPackagePath)) throw new WorkbenchError('INVALID_REQUEST', 'Native binding package path must be absolute.');
  }

  async open(options: SerialOptions): Promise<SerialConnection> {
    canonicalTransportPath(options.path);
    if (!Number.isSafeInteger(options.baudRate) || options.baudRate < 1 || options.baudRate > 4000000 || options.dataBits !== 8 || options.stopBits !== 1 || options.parity !== 'none') {
      throw new WorkbenchError('INVALID_REQUEST', 'Choose an explicit supported 8N1 serial configuration.');
    }
    if (!this.binding) {
      try {
        this.binding = this.bindingFactory ? this.bindingFactory() :
          (createRequire(__filename)(this.bindingPackagePath ?? '@serialport/bindings-cpp') as { autoDetect(): NativeBinding }).autoDetect();
      } catch { throw new WorkbenchError('TOOL_UNAVAILABLE', 'The native serial binding could not load in the selected companion runtime.'); }
    }
    let port: NativePort;
    try { port = await this.binding.open({ ...options, path: canonicalTransportPath(options.path) }); }
    catch { throw new WorkbenchError('DEVICE_BUSY', 'Serial port could not open; check the selected device and external port ownership.'); }
    const data = new Set<(bytes: Uint8Array) => void>();
    const disconnected = new Set<(error?: Error) => void>();
    let stopping = false;
    let closePromise: Promise<void> | undefined;
    const closePort = () => {
      stopping = true;
      closePromise ??= port.isOpen ? port.close() : Promise.resolve();
      return closePromise;
    };
    const readLoop = async () => {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      try {
        while (!stopping) {
          const result = await port.read(buffer, 0, buffer.length);
          if (stopping) break;
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > buffer.length) throw new Error('Invalid native serial read result.');
          for (const listener of [...data]) { try { listener(Buffer.from(result.buffer.subarray(0, result.bytesRead))); } catch { data.delete(listener); } }
        }
      } catch (error) {
        if (!stopping) {
          stopping = true;
          const diagnostic = new WorkbenchError('DEVICE_BUSY', 'Serial transport disconnected; retained bytes remain available.');
          for (const listener of [...disconnected]) { try { listener(diagnostic); } catch {} }
          try { await closePort(); } catch { /* The coordinator observes the same rejected close promise. */ }
        } else if (!(error as { canceled?: boolean }).canceled && port.isOpen) {
          throw new WorkbenchError('OUTCOME_UNKNOWN', 'Serial read ended without confirmed handle closure.');
        }
      }
    };
    let loop = Promise.resolve();
    let reading = false;
    const start = () => { if (!reading && !stopping) { reading = true; loop = readLoop(); void loop.catch(() => {}); } };
    return {
      onData(listener) { data.add(listener); queueMicrotask(start); return () => data.delete(listener); },
      onDisconnect(listener) { disconnected.add(listener); return () => disconnected.delete(listener); },
      async close() {
        await closePort();
        await loop;
        if (port.isOpen) throw new WorkbenchError('OUTCOME_UNKNOWN', 'Serial handle closure was not observed.');
        data.clear(); disconnected.clear();
      }
    };
  }
}
