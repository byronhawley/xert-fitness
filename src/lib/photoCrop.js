/**
 * Geometry for the coach photo cropper. The frame matches the Coaches page
 * card (4:5). Everything is measured in "frame widths" so the same state works
 * at any on-screen size: the frame is 1 wide and FRAME_ASPECT tall.
 *
 * State is `{ cx, cy, zoom }`: the point of the image (as fractions of its
 * width and height) that sits in the middle of the frame, and how far past
 * "just covers the frame" it is zoomed. The photo always covers the frame, so
 * there are never empty bars on the card.
 */

export const FRAME_ASPECT = 5 / 4;
export const MAX_ZOOM = 4;
export const OUTPUT_WIDTH = 1080;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Image pixels → frame widths at zoom 1 (the image just covers the frame). */
export function coverScale(width, height) {
  return Math.max(1 / width, FRAME_ASPECT / height);
}

/** Keeps zoom in range and the frame fully covered by the image. */
export function clampCrop(state, width, height) {
  const zoom = clamp(Number(state.zoom) || 1, 1, MAX_ZOOM);
  const scale = coverScale(width, height) * zoom;
  const halfX = 0.5 / (scale * width);
  const halfY = (FRAME_ASPECT / 2) / (scale * height);
  return {
    zoom,
    cx: clamp(Number.isFinite(state.cx) ? state.cx : 0.5, halfX, 1 - halfX),
    cy: clamp(Number.isFinite(state.cy) ? state.cy : 0.5, halfY, 1 - halfY),
  };
}

/** Moves the photo by a drag of (dx, dy) frame widths. */
export function panCrop(state, dx, dy, width, height) {
  const scale = coverScale(width, height) * state.zoom;
  return clampCrop({ ...state, cx: state.cx - dx / (scale * width), cy: state.cy - dy / (scale * height) }, width, height);
}

/** Zooms, keeping the point under (fx, fy) — frame widths from the frame's top-left — still. */
export function zoomCrop(state, nextZoom, width, height, fx = 0.5, fy = FRAME_ASPECT / 2) {
  const zoom = clamp(nextZoom, 1, MAX_ZOOM);
  const before = coverScale(width, height) * state.zoom;
  const after = coverScale(width, height) * zoom;
  // Image point under the focus before the zoom…
  const px = state.cx + (fx - 0.5) / (before * width);
  const py = state.cy + (fy - FRAME_ASPECT / 2) / (before * height);
  // …stays under it after.
  return clampCrop({ zoom, cx: px - (fx - 0.5) / (after * width), cy: py - (fy - FRAME_ASPECT / 2) / (after * height) }, width, height);
}

/** Where to draw the image inside the frame, as CSS percentages of the frame. */
export function imageStyle(state, width, height) {
  const scale = coverScale(width, height) * state.zoom;
  return {
    width: `${width * scale * 100}%`,
    left: `${(0.5 - state.cx * width * scale) * 100}%`,
    top: `${((FRAME_ASPECT / 2 - state.cy * height * scale) / FRAME_ASPECT) * 100}%`,
  };
}

/** The part of the original image (in its pixels) that the frame shows. */
export function sourceRect(state, width, height) {
  const scale = coverScale(width, height) * state.zoom;
  const sw = 1 / scale;
  const sh = FRAME_ASPECT / scale;
  return {
    sx: clamp(state.cx * width - sw / 2, 0, width - sw),
    sy: clamp(state.cy * height - sh / 2, 0, height - sh),
    sw,
    sh,
  };
}

/** Output size: 4:5, no wider than OUTPUT_WIDTH, never upscaled past the source. */
export function outputSize(rect) {
  const width = Math.max(1, Math.round(Math.min(OUTPUT_WIDTH, rect.sw)));
  return { width, height: Math.round(width * FRAME_ASPECT) };
}

/** Draws the framed part of `image` to a 4:5 JPEG Blob. Browser only. */
export async function cropToBlob(image, state, doc = globalThis.document) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const rect = sourceRect(clampCrop(state, width, height), width, height);
  const size = outputSize(rect);
  const canvas = doc.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Couldn’t save the photo. Try again.'))), 'image/jpeg', 0.88);
  });
}
