import React, { useEffect, useRef, useState } from 'react';
import { clampCrop, cropToBlob, FRAME_ASPECT, imageStyle, MAX_ZOOM, panCrop, zoomCrop } from '@/lib/photoCrop';
import { Banner, BUTTON, GHOST, Sheet } from './coachingUi';

const START = { cx: 0.5, cy: 0.5, zoom: 1 };

/** Loads a picked file, or an already-uploaded photo, as a same-origin object URL the canvas can read. */
async function objectUrlFor(source) {
  if (source.file) return URL.createObjectURL(source.file);
  const response = await fetch(source.url, { mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error('Couldn’t open your current photo. Upload it again to position it.');
  return URL.createObjectURL(await response.blob());
}

/**
 * Drag to move, pinch (or the slider) to zoom. The frame is the same 4:5 shape
 * as the card on the Coaches page, so what the coach sees is what members see.
 * `source` is `{ file }` for a newly picked photo or `{ url }` to re-position
 * the current one; `onDone` gets the cropped JPEG.
 */
export default function PhotoCropper({ source, onCancel, onDone, busy = false }) {
  const [src, setSrc] = useState(null);
  const [size, setSize] = useState(null);
  const [crop, setCrop] = useState(START);
  const [error, setError] = useState(null);
  const frame = useRef(null);
  const image = useRef(null);
  const pointers = useRef(new Map());
  const latest = useRef({ crop, size });
  latest.current = { crop, size };

  useEffect(() => {
    if (!source) return undefined;
    let url = null;
    let cancelled = false;
    setSrc(null); setSize(null); setCrop(START); setError(null);
    objectUrlFor(source)
      .then(next => { url = next; if (cancelled) URL.revokeObjectURL(next); else setSrc(next); })
      .catch(failure => { if (!cancelled) setError(failure.message || 'Couldn’t open that photo.'); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [source]);

  // Wheel / trackpad zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const node = frame.current;
    if (!node) return undefined;
    const onWheel = event => {
      const { crop: current, size: dims } = latest.current;
      if (!dims) return;
      event.preventDefault();
      const box = node.getBoundingClientRect();
      const next = current.zoom * Math.exp(-event.deltaY / 400);
      setCrop(zoomCrop(current, next, dims.width, dims.height, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.width));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [src]);

  if (!source) return null;

  const loaded = event => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    if (!width || !height) { setError('Couldn’t open that photo. Try a JPG or PNG.'); return; }
    setSize({ width, height });
    setCrop(clampCrop(START, width, height));
  };

  const down = event => {
    if (!size) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const move = event => {
    const known = pointers.current;
    if (!size || !known.has(event.pointerId)) return;
    const box = frame.current.getBoundingClientRect();
    const before = [...known.values()];
    known.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...known.values()];
    if (after.length === 1) {
      setCrop(current => panCrop(current, (after[0].x - before[0].x) / box.width, (after[0].y - before[0].y) / box.width, size.width, size.height));
      return;
    }
    const [a0, b0] = before; const [a1, b1] = after;
    const gap0 = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1;
    const gap1 = Math.hypot(a1.x - b1.x, a1.y - b1.y) || 1;
    const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    const mid1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    setCrop(current => {
      const zoomed = zoomCrop(current, current.zoom * (gap1 / gap0), size.width, size.height, (mid1.x - box.left) / box.width, (mid1.y - box.top) / box.width);
      return panCrop(zoomed, (mid1.x - mid0.x) / box.width, (mid1.y - mid0.y) / box.width, size.width, size.height);
    });
  };
  const up = event => { pointers.current.delete(event.pointerId); };
  const key = event => {
    if (!size) return;
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) { event.preventDefault(); setCrop(current => panCrop(current, ...moves[event.key], size.width, size.height)); }
    if (event.key === '+' || event.key === '=') setCrop(current => zoomCrop(current, current.zoom * 1.1, size.width, size.height));
    if (event.key === '-') setCrop(current => zoomCrop(current, current.zoom / 1.1, size.width, size.height));
  };

  const finish = async () => {
    try { onDone(await cropToBlob(image.current, crop)); }
    catch { setError('Couldn’t save the photo here. Upload it again to position it.'); }
  };

  return (
    <Sheet
      open
      title="Position photo"
      onClose={onCancel}
      footer={<>
        <button type="button" className={BUTTON} disabled={busy || !size || Boolean(error)} onClick={finish}>{busy ? 'Saving…' : 'Use this photo'}</button>
        <button type="button" className={GHOST} disabled={busy} onClick={onCancel}>Cancel</button>
      </>}
    >
      <p className="font-body text-sm text-xert-pale/70">Drag to move, pinch to zoom. This is how your card looks on the Coaches page.</p>
      {error
        ? <Banner tone="danger" title="Couldn’t use that photo">{error}</Banner>
        : (
          <>
            <div
              ref={frame}
              className="coaching-cropper"
              style={{ aspectRatio: `1 / ${FRAME_ASPECT}` }}
              tabIndex={0}
              role="img"
              aria-label="Photo position. Drag to move, or use the arrow keys. Plus and minus zoom."
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={key}
            >
              {src && <img ref={image} src={src} alt="" draggable={false} onLoad={loaded} onError={() => setError('Couldn’t open that photo. Try a JPG or PNG.')} style={size ? imageStyle(crop, size.width, size.height) : { opacity: 0 }} />}
              {!size && <span className="coaching-cropper-loading" role="status">Loading photo…</span>}
            </div>
            <div className="flex items-center gap-3">
              <label htmlFor="coach-photo-zoom" className="font-body text-xs uppercase tracking-wider text-xert-pale/60">Zoom</label>
              <input
                id="coach-photo-zoom"
                type="range"
                min="1"
                max={MAX_ZOOM}
                step="0.01"
                className="flex-1 min-h-11"
                disabled={!size}
                value={crop.zoom}
                onChange={event => size && setCrop(current => zoomCrop(current, Number(event.target.value), size.width, size.height))}
              />
              <button type="button" className={GHOST} disabled={!size} onClick={() => size && setCrop(clampCrop(START, size.width, size.height))}>Reset</button>
            </div>
          </>
        )}
    </Sheet>
  );
}
