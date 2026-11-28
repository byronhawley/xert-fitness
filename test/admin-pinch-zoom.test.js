import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the admin scroll area still lets people pinch-zoom', () => {
  // touch-pan-y on its own computes to `touch-action: pan-y`, which blocks
  // pinch. Once iPhone Safari zoomed in, nobody could pinch back out of the
  // admin. Vertical-only scrolling stays; pinch-zoom is added back.
  const layout = readFileSync(new URL('../src/components/admin/AdminLayout.jsx', import.meta.url), 'utf8');
  const main = layout.match(/<main ref=\{mainRef\} data-admin-scroll-region className="([^"]+)"/);
  assert.ok(main, 'the admin scroll region is where it was');
  const classes = main[1].split(/\s+/);
  assert.ok(classes.includes('touch-pinch-zoom'), 'pinch-zoom must be allowed');
  assert.ok(!classes.includes('touch-none'));
});
