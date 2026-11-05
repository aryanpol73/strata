import * as Y from 'yjs';
import type { BlockJoinResult, ClientToServerEvents, ServerToClientEvents } from '@strata/shared';
import type { Socket } from 'socket.io-client';

type BlockSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const REMOTE = 'remote';
/** Keystrokes inside this window travel as one update. */
const FLUSH_MS = 120;

export type BlockStatus = 'joining' | 'live' | 'offline' | 'denied';

/**
 * One live connection between a Y.Doc and the server, shared by every view of the same block. The doc is the source
 * of truth on this device: edits apply locally at once and survive a dropped connection. On rejoin, each side sends
 * the other only what it lacks, and the CRDT reconciles the rest.
 */
export class BlockSession {
  /** Replaced after a refused edit, so views must read this each render rather than holding on to it. */
  doc = new Y.Doc();
  status: BlockStatus = 'joining';
  canEdit = false;
  error: string | null = null;

  private listeners = new Set<() => void>();
  private queue: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private refs = 0;

  constructor(
    readonly blockId: string,
    private socket: BlockSocket,
  ) {
    this.bind(this.doc);
    socket.on('block:update', this.onRemoteUpdate);
    socket.on('disconnect', this.onDisconnect);
    this.join();
  }

  private bind(doc: Y.Doc) {
    doc.on('update', this.onLocalUpdate);
    doc.on('update', this.notify);
  }

  retain() {
    this.refs += 1;
  }

  release(): boolean {
    this.refs -= 1;
    return this.refs <= 0;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify = () => this.listeners.forEach((fn) => fn());

  private setStatus(status: BlockStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    this.notify();
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    this.queue.push(update);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  };

  private onRemoteUpdate = ({ blockId, update }: { blockId: string; update: Uint8Array }) => {
    if (blockId === this.blockId) Y.applyUpdate(this.doc, new Uint8Array(update), REMOTE);
  };

  private onDisconnect = () => this.setStatus('offline');

  join = () => {
    if (!this.socket.connected) {
      this.setStatus('offline');
      return;
    }
    this.socket.emit('block:join', { blockId: this.blockId, stateVector: Y.encodeStateVector(this.doc) }, (res) => {
      if (!res.ok) {
        this.setStatus('denied', res.message);
        return;
      }
      this.reconcile(res.data);
    });
  };

  private reconcile(data: BlockJoinResult) {
    Y.applyUpdate(this.doc, new Uint8Array(data.diff), REMOTE);
    this.canEdit = data.canEdit;
    this.setStatus('live');
    // Whatever the server's state vector doesn't cover is what we did while offline.
    const missing = Y.encodeStateAsUpdate(this.doc, new Uint8Array(data.stateVector));
    this.queue = [];
    if (missing.byteLength > 2) {
      this.queue.push(missing);
      void this.flush();
    }
  }

  private async flush() {
    if (this.sending || !this.queue.length || !this.socket.connected || this.status !== 'live') return;
    this.sending = true;
    const update = Y.mergeUpdates(this.queue);
    this.queue = [];
    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      this.socket.timeout(8000).emit('block:update', { blockId: this.blockId, update, clientUpdateId: crypto.randomUUID() }, (err, res) => {
        resolve(err ? { ok: false, message: 'timeout' } : res);
      });
    });
    this.sending = false;

    if (result.ok) {
      if (this.queue.length) void this.flush();
      return;
    }
    if (result.message === 'timeout') {
      this.queue.unshift(update);
      return;
    }
    // Refused by the server. Local state is now ahead of the truth, so start again from the server's copy.
    this.error = result.message ?? 'That change was not accepted';
    this.rebuild();
  }

  /**
   * Starts again from the server's copy, with a new Y.Doc rather than a repaired one. A refused update has already
   * advanced this client's Yjs clock past what the server holds, so anything built on this doc would depend on a change
   * the server will never have, and every later edit would be refused as out of sync.
   */
  private rebuild() {
    this.socket.emit('block:join', { blockId: this.blockId }, (res) => {
      if (!res.ok) {
        this.setStatus('denied', res.message);
        return;
      }
      const fresh = new Y.Doc();
      Y.applyUpdate(fresh, new Uint8Array(res.data.diff), REMOTE);
      this.bind(fresh);
      const stale = this.doc;
      this.doc = fresh;
      this.queue = [];
      stale.destroy();
      this.notify();
    });
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    this.socket.off('block:update', this.onRemoteUpdate);
    this.socket.off('disconnect', this.onDisconnect);
    this.doc.destroy();
  }
}

const sessions = new Map<string, BlockSession>();

export function acquireSession(blockId: string, socket: BlockSocket): BlockSession {
  let session = sessions.get(blockId);
  if (!session) {
    session = new BlockSession(blockId, socket);
    sessions.set(blockId, session);
  }
  session.retain();
  return session;
}

export function releaseSession(session: BlockSession) {
  if (session.release()) {
    session.destroy();
    sessions.delete(session.blockId);
  }
}

export const rejoinAll = () => sessions.forEach((s) => s.join());
