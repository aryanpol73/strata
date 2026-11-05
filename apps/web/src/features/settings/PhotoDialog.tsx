import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { SelfDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Button, Dialog } from '../../components/ui';
import { toastError, useStore } from '../../state/store';

const VIEW = 260;
const OUTPUT = 256;

/**
 * Crops in the browser, so the server stores one small image. Redrawing through a canvas also drops the file's metadata,
 * which on a phone photo can include where it was taken.
 */
export function PhotoDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    createImageBitmap(file)
      .then((bitmap) => {
        if (live) setImage(bitmap);
      })
      .catch(() => {
        toastError(new Error('That image could not be opened'));
        onClose();
      });
    return () => {
      live = false;
    };
  }, [file, onClose]);

  /** Keeps the picture covering the circle, however far it's dragged. */
  const place = (size: number) => {
    if (!image) return null;
    const scale = (size / Math.min(image.width, image.height)) * zoom;
    const width = image.width * scale;
    const height = image.height * scale;
    const ratio = size / VIEW;
    const clamp = (value: number, room: number) => Math.min(room / 2, Math.max(-room / 2, value));
    return { width, height, x: (size - width) / 2 + clamp(offset.x * ratio, width - size), y: (size - height) / 2 + clamp(offset.y * ratio, height - size) };
  };

  const paint = (target: HTMLCanvasElement, size: number) => {
    const spot = place(size);
    const g = target.getContext('2d');
    if (!spot || !g || !image) return;
    g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, size, size);
    g.drawImage(image, spot.x, spot.y, spot.width, spot.height);
  };

  useEffect(() => {
    if (canvas.current) paint(canvas.current, VIEW);
  });

  const move = (e: PointerEvent) => {
    if (!drag.current) return;
    const { x, y } = drag.current;
    drag.current = { x: e.clientX, y: e.clientY };
    setOffset((o) => ({ x: o.x + e.clientX - x, y: o.y + e.clientY - y }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const out = document.createElement('canvas');
      out.width = out.height = OUTPUT;
      paint(out, OUTPUT);
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/webp', 0.86));
      if (!blob) throw new Error('That image could not be prepared');
      const { user } = await api<{ user: SelfDTO }>('/users/me/avatar', { method: 'POST', raw: blob, headers: { 'content-type': blob.type } });
      useStore.setState({ me: user });
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Position your photo"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!image} onClick={save}>
            Save photo
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3">
        <canvas
          ref={canvas}
          width={VIEW}
          height={VIEW}
          aria-label="Photo preview. Drag to reposition."
          className="size-[260px] cursor-grab touch-none rounded-full bg-tint-plain active:cursor-grabbing"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={move}
          onPointerUp={() => {
            drag.current = null;
          }}
        />
        <label className="flex w-full max-w-[260px] items-center gap-3 text-[13px] font-medium text-ink-2">
          Zoom
          <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--violet-fill)]" />
        </label>
      </div>
    </Dialog>
  );
}
