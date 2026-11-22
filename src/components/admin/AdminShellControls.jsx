import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { readPreferences, savePreferences, matchShortcut } from '@/lib/adminCommandSystem';
import { navDesktopMediaQuery } from '@/components/public/nav/navTokens';

function dimensions() {
  const css = getComputedStyle(document.documentElement);
  const get = name => parseFloat(css.getPropertyValue(`--admin-sidebar-${name}`));
  return { min: get('min'), max: get('max'), initial: get('default'), step: get('step') };
}
export function useAdminShellControls({ onNavigate, onPalette, desktopNavigation }) {
  const [density, setDensity] = useState(() => readPreferences().density === 'compact' ? 'compact' : 'comfortable');
  const [collapsed, setCollapsed] = useState(() => readPreferences().collapsed === true);
  const [width, setWidth] = useState(() => {
    const { min, max, initial } = dimensions();
    return Math.max(min, Math.min(max, Number(readPreferences().width) || initial));
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const drag = useRef(null);
  useEffect(() => { savePreferences(null, { density, collapsed, width }); }, [density, collapsed, width]);
  useEffect(() => { if (!desktopNavigation) drag.current = null; }, [desktopNavigation]);
  useEffect(() => {
    let prefixAt = 0;
    const onKey = event => {
      const typing = !!event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
      const modal = !!document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]:not([aria-hidden="true"]), [role="alertdialog"][aria-modal="true"]');
      const action = matchShortcut(event, { typing, modal, prefix: Date.now() - prefixAt < 1000 });
      prefixAt = 0;
      if (!action) return;
      event.preventDefault();
      if (action === 'prefix') prefixAt = Date.now();
      else if (action === 'palette') onPalette();
      else if (action === 'shortcuts') setShortcutsOpen(true);
      else onNavigate(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNavigate, onPalette]);
  const clamp = value => {
    const { min, max } = dimensions();
    setWidth(Math.max(min, Math.min(max, value)));
  };
  /** @type {React.HTMLAttributes<HTMLDivElement>} */
  const resizeProps = {
    role: 'separator', 'aria-label': 'Resize navigation', 'aria-orientation': 'vertical',
    'aria-valuemin': dimensions().min, 'aria-valuemax': dimensions().max, 'aria-valuenow': width,
    tabIndex: desktopNavigation && !collapsed ? 0 : -1,
    onKeyDown: event => {
      if (!desktopNavigation || collapsed) return;
      const { min, max, step } = dimensions();
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      clamp(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? step : -step));
    },
    onPointerDown: event => {
      if (!desktopNavigation || collapsed || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus();
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: event => { if (drag.current && desktopNavigation) clamp(drag.current.width + event.clientX - drag.current.x); },
    onPointerUp: event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); },
    onPointerCancel: () => { drag.current = null; },
    onLostPointerCapture: () => { drag.current = null; },
  };
  return { density, setDensity, collapsed, setCollapsed, width, resizeProps, shortcutsOpen, setShortcutsOpen };
}
export { navDesktopMediaQuery };

export function WorkspaceTabs({ items, activeSection, navigateTo, badges }) {
  const ref = useRef(null);
  const [focusedTab, setFocusedTab] = useState(activeSection);
  useEffect(() => { setFocusedTab(activeSection); }, [activeSection, items]);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const element = ref.current;
    const measure = () => {
      const selected = element.querySelector('[aria-selected="true"]');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      sync();
    };
    const sync = () => {
      const left = element.scrollLeft > 1;
      const right = element.scrollWidth - element.clientWidth - element.scrollLeft > 1;
      setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); element.addEventListener('scroll', sync); measure();
    return () => { observer.disconnect(); element.removeEventListener('scroll', sync); };
  }, [items, activeSection]);
  return <div className="admin-tabs-wrap" data-overflow-left={edges.left} data-overflow-right={edges.right}>
    <div ref={ref} role="tablist" aria-label="Workspace sections" className="admin-tabs" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...ref.current.querySelectorAll('[role="tab"]')];
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }}>
      {items.map(item => <button type="button" role="tab" key={item.key} tabIndex={focusedTab === item.key ? 0 : -1} onFocus={() => setFocusedTab(item.key)}
        aria-selected={activeSection === item.key} onClick={() => navigateTo(item)}>
        {item.label}{badges[item.key] > 0 && <span>{badges[item.key]}</span>}
        {activeSection === item.key && <span aria-hidden="true" className="admin-tab-indicator" />}
      </button>)}
    </div>
  </div>;
}
export function KeyboardShortcuts({ open, onOpenChange }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogTitle>Keyboard shortcuts</DialogTitle>
    <dl className="admin-shortcuts">
      {[['⌘ / Ctrl K', 'Find an owner task'], ['g then t', 'Today'], ['g then c', 'Class calendar'], ['g then p', 'Members'], ['g then m', 'Text members'], ['g then w', 'Forms & surveys'], ['g then b', 'Orders & revenue'], ['?', 'Keyboard shortcuts'], ['← / →, Home / End', 'Move through workspace tabs; Enter selects']].map(([key, value]) => <React.Fragment key={key}><dt><kbd>{key}</kbd></dt><dd>{value}</dd></React.Fragment>)}
    </dl><p>Navigation shortcuts pause while typing or while a dialog is open.</p>
  </DialogContent></Dialog>;
}
