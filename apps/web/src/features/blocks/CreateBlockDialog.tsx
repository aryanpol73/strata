import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Dialog, Field, Input, Textarea } from '../../components/ui';
import { toastError } from '../../state/store';

export type BlockKind = 'checklist' | 'roster' | 'info';

const TITLES: Record<BlockKind, string> = { checklist: 'New checklist', roster: 'New sign-up roster', info: 'New info card' };

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export function CreateBlockDialog({ roomId, kind, onClose }: { roomId: string; kind: BlockKind; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [capacity, setCapacity] = useState(1);
  const [busy, setBusy] = useState(false);

  const data = () => {
    if (kind === 'checklist') return { title, items: lines(body) };
    if (kind === 'roster') return { title, slots: lines(body).map((label) => ({ label, capacity })) };
    return { title, fields: lines(body).map((label) => ({ label, value: '' })) };
  };

  const valid = title.trim() && (kind !== 'roster' || lines(body).length > 0);

  const create = async () => {
    setBusy(true);
    try {
      await api(`/rooms/${roomId}/blocks`, { method: 'POST', body: { type: kind, clientMessageId: crypto.randomUUID(), data: data() } });
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={TITLES[kind]}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={create}>
            Add to conversation
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field
          label={kind === 'checklist' ? 'Items' : kind === 'roster' ? 'Slots' : 'Fields'}
          hint="One per line. Everyone in the conversation shares this and sees changes live."
        >
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {kind === 'roster' && (
          <Field label="Places per slot">
            <Input type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(Math.max(1, Number(e.target.value)))} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
