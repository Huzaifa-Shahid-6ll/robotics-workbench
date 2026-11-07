import type { SerialConnection, SerialTransport } from '@robotics-workbench/devices';

const key = (path: string) => path.replace(/^\\\\\.\\/, '').toUpperCase();

/** Synthetic transport: records only declared open/close/data/disconnect boundaries. */
export class FakeSerialTransport implements SerialTransport {
  readonly trace: string[] = [];
  readonly connections: FakeSerialConnection[] = [];
  failOpen?: Error;
  failClose?: Error;

  constructor(private delayedClose = false) {}

  finishPendingCloses(): void {
    this.delayedClose = false;
    for (const connection of this.connections) if (connection.closeRequested) connection.releaseClose();
  }

  shouldDelayClose(): boolean { return this.delayedClose; }

  async open(options: { path: string; baudRate: number; dataBits: 8; stopBits: 1; parity: 'none' }): Promise<SerialConnection> {
    this.trace.push(`open-request:${options.path}`);
    if (this.failOpen) throw this.failOpen;
    if (this.connections.some(connection => key(connection.path) === key(options.path) && !connection.closed)) throw new Error('Synthetic external port contention.');
    const connection = new FakeSerialConnection(this, options.path);
    this.connections.push(connection);
    this.trace.push(`open:${options.path}`);
    return connection;
  }

  connection(path: string): FakeSerialConnection {
    const connection = this.connections.slice().reverse().find(item => key(item.path) === key(path) && !item.closed);
    if (!connection) throw new Error('No open synthetic connection.');
    return connection;
  }

  emit(path: string, bytes: Uint8Array): void { this.connection(path).emit(bytes); }
  disconnect(path: string, error?: Error): void { this.connection(path).disconnect(error); }
  releaseClose(path: string): void { this.connection(path).releaseClose(); }
}

export class FakeSerialConnection implements SerialConnection {
  closed = false;
  closeRequested = false;
  private closing?: Promise<void>;
  private release?: () => void;
  private readonly data = new Set<(bytes: Uint8Array) => void>();
  private readonly disconnected = new Set<(error?: Error) => void>();
  private announceClose!: () => void;
  readonly closeStarted = new Promise<void>(resolve => { this.announceClose = resolve; });

  constructor(private readonly transport: FakeSerialTransport, readonly path: string) {}

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closeRequested = true;
    this.announceClose();
    this.transport.trace.push(`close-request:${this.path}`);
    if (this.transport.failClose) return Promise.reject(this.transport.failClose);
    this.closing = new Promise(resolve => { this.release = () => {
      if (!this.closed) { this.closed = true; this.transport.trace.push(`close:${this.path}`); }
      resolve();
    }; });
    if (!this.transport.shouldDelayClose()) this.release!();
    return this.closing;
  }

  releaseClose(): void {
    if (!this.closeRequested) throw new Error('No synthetic close has been requested.');
    this.release?.();
  }

  onData(listener: (bytes: Uint8Array) => void): () => void { this.data.add(listener); return () => { this.data.delete(listener); }; }
  onDisconnect(listener: (error?: Error) => void): () => void { this.disconnected.add(listener); return () => { this.disconnected.delete(listener); }; }
  emit(bytes: Uint8Array): void { if (!this.closed) for (const listener of this.data) listener(new Uint8Array(bytes)); }
  disconnect(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.trace.push(`disconnect:${this.path}`);
    for (const listener of this.disconnected) listener(error);
    this.release?.();
  }
}
