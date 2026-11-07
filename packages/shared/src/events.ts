import type { AckStatusDTO, NotificationDTO } from './delivery.js';
import type { MessageDTO } from './messages.js';
import type { BranchInfoDTO, RoomDTO } from './rooms.js';

export interface TypingEvent {
  roomId: string;
  principalId: string;
  name: string;
  active: boolean;
}
export interface ReceiptEvent {
  roomId: string;
  principalId: string;
  deliveredSeq: number;
  readSeq: number;
}
export type CanvasChange = { kind: 'block'; blockId: string } | { kind: 'block_removed'; blockId: string } | { kind: 'sections' };

export interface ServerToClientEvents {
  'message:new': (e: { message: MessageDTO }) => void;
  'message:updated': (e: { message: MessageDTO }) => void;
  'room:updated': (e: { room: Partial<RoomDTO> & { id: string } }) => void;
  'room:joined': (e: { roomId: string }) => void;
  'room:left': (e: { roomId: string }) => void;
  'member:updated': (e: { roomId: string; userId: string }) => void;
  receipt: (e: ReceiptEvent) => void;
  typing: (e: TypingEvent) => void;
  presence: (e: { userId: string; online: boolean }) => void;
  'branch:updated': (e: { roomId: string; parentRoomId: string | null; branch: Partial<BranchInfoDTO> }) => void;
  'block:update': (e: { blockId: string; seq: number; update: Uint8Array; origin: string }) => void;
  'canvas:changed': (e: { roomId: string; change: CanvasChange }) => void;
  'notification:new': (e: { notification: NotificationDTO }) => void;
  /** Someone's keys changed, or a key was shared, so this client should check what it can now open. */
  'keys:updated': (e: { roomId: string }) => void;
  'ack:updated': (e: { roomId: string; status: AckStatusDTO }) => void;
  'session:revoked': (e: { reason: string }) => void;
}

export type Ack<T> = (result: { ok: true; data: T } | { ok: false; code: string; message: string }) => void;

export interface BlockJoinResult {
  diff: Uint8Array;
  stateVector: Uint8Array;
  canEdit: boolean;
  seq: number;
}

export interface ClientToServerEvents {
  typing: (e: { roomId: string; active: boolean }) => void;
  /** Tells the server whether this window is in front, so a notification goes where someone will see it. */
  'client:visibility': (e: { visible: boolean }) => void;
  'receipt:delivered': (e: { roomId: string; seq: number }) => void;
  'block:join': (e: { blockId: string; stateVector?: Uint8Array }, ack: Ack<BlockJoinResult>) => void;
  'block:update': (e: { blockId: string; update: Uint8Array; clientUpdateId: string }, ack: Ack<{ seq: number }>) => void;
}
