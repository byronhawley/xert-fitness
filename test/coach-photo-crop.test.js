import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampCrop, coverScale, FRAME_ASPECT, imageStyle, outputSize, panCrop, sourceRect, zoomCrop } from '../src/lib/photoCrop.js';
import { createStaffFiles, fileProblem } from '../src/lib/staffFiles.js';

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

test('a landscape phone photo starts centred and fills the 4:5 card', () => {
  const [w, h] = [4032, 3024];
  const crop = clampCrop({ cx: 0.5, cy: 0.5, zoom: 1 }, w, h);
  const rect = sourceRect(crop, w, h);
  close(rect.sh, h, 'uses full height');
  close(rect.sw / rect.sh, 1 / FRAME_ASPECT, '4:5');
  close(rect.sx, (w - rect.sw) / 2, 'centred');
  close(rect.sy, 0, 'top');
});

test('dragging never leaves empty space and moves the visible part', () => {
  const [w, h] = [1000, 2000];
  let crop = clampCrop({ cx: 0.5, cy: 0.5, zoom: 1 }, w, h);
  // Dragging the photo down shows more of the top (where faces usually are).
  crop = panCrop(crop, 0, 0.2, w, h);
  assert.ok(sourceRect(crop, w, h).sy < sourceRect(clampCrop({ cx: 0.5, cy: 0.5, zoom: 1 }, w, h), w, h).sy);
  // A huge drag stops at the edge.
  crop = panCrop(crop, 5, 50, w, h);
  const rect = sourceRect(crop, w, h);
  close(rect.sx, 0, 'left edge');
  close(rect.sy, 0, 'top edge');
  const style = imageStyle(crop, w, h);
  close(parseFloat(style.left), 0, 'image left at frame left');
  close(parseFloat(style.top), 0, 'image top at frame top');
});

test('zoom stays between 1x and 4x and keeps the pinch point still', () => {
  const [w, h] = [3000, 4000];
  const start = clampCrop({ cx: 0.5, cy: 0.5, zoom: 1 }, w, h);
  assert.equal(zoomCrop(start, 0.2, w, h).zoom, 1);
  assert.equal(zoomCrop(start, 10, w, h).zoom, 4);
  const focus = [0.5, 0.3];
  const zoomed = zoomCrop(start, 2, w, h, ...focus);
  const pointUnder = state => {
    const scale = coverScale(w, h) * state.zoom;
    return [state.cx + (focus[0] - 0.5) / (scale * w), state.cy + (focus[1] - FRAME_ASPECT / 2) / (scale * h)];
  };
  pointUnder(start).forEach((value, i) => close(pointUnder(zoomed)[i], value, `axis ${i}`));
  close(sourceRect(zoomed, w, h).sw, sourceRect(start, w, h).sw / 2, 'half the width at 2x');
});

test('output is 4:5, capped at 1080 wide and never upscaled', () => {
  assert.deepEqual(outputSize({ sw: 2400 }), { width: 1080, height: 1350 });
  assert.deepEqual(outputSize({ sw: 600 }), { width: 600, height: 750 });
});

test('big phone photos can be picked; the cropped upload is a named-less JPEG blob', async () => {
  assert.equal(fileProblem({ type: 'image/jpeg', size: 12 * 1024 * 1024 }, 'photo-pick'), null);
  assert.match(fileProblem({ type: 'image/jpeg', size: 31 * 1024 * 1024 }, 'photo-pick'), /30 MB/);
  assert.match(fileProblem({ type: 'application/pdf', size: 10 }, 'photo-pick'), /image/);
  const calls = [];
  const storage = { from: bucket => ({
    upload: async (path, file, options) => { calls.push({ bucket, path, options }); return { error: null }; },
    getPublicUrl: path => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
  }) };
  const url = await createStaffFiles(storage).uploadProfilePhoto('uid-1', { type: 'image/jpeg', size: 200_000 });
  assert.match(calls[0].path, /^staff-profiles\/uid-1\/\d+-[0-9a-f]{8}\.jpg$/);
  assert.equal(calls[0].options.contentType, 'image/jpeg');
  // The database only accepts this exact URL shape for coach photos.
  assert.match(url, /^https:\/\/[A-Za-z0-9.-]+\/storage\/v1\/object\/public\/site-images\/[A-Za-z0-9._/-]+$/);
});
