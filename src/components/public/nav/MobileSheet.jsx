import React, { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, ChevronDown, Clock3, UserRound, X } from 'lucide-react';

const MenuInformation = lazy(() => import('./MenuInformation'));

export default function MobileSheet({ groups, shortcuts, current, user, profile, close, triggerRef }) {
  const dialogRef = useRef(null);
  const dragStart = useRef(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    const previous = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previous;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  const endDrag = event => {
    if (dragStart.current === null) return;
    const distance = event.clientY - dragStart.current;
    dragStart.current = null;
    dialogRef.current.style.removeProperty('transform');
    if (event.type === 'pointerup' && distance > 72) close();
  };

  return <dialog ref={dialogRef} id="mobile-navigation" aria-labelledby="public-menu-title"
    className="public-nav-sheet" onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== dialogRef.current) return;
      const box = dialogRef.current.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...dialogRef.current.querySelectorAll('a[href],button:not([disabled])')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <div className="public-menu-grip" aria-hidden="true"
      onPointerDown={event => { dragStart.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (dragStart.current !== null) dialogRef.current.style.transform = 'translateY(' + Math.max(0, event.clientY - dragStart.current) * .65 + 'px)'; }}
      onPointerUp={endDrag} onPointerCancel={endDrag}><span /></div>
    <header className="public-menu-top"><h2 id="public-menu-title">Menu</h2>
      <button type="button" aria-label="Close navigation menu" onClick={close} className="public-menu-close"><X size={21} aria-hidden="true" /></button>
    </header>
    <div data-nav-sheet-scroll className="public-menu-scroll">
      {shortcuts.length > 0 && <section aria-label="Your shortcuts" className="public-menu-shortcuts">
        {shortcuts.map(({ to, label, icon: Icon }) => <Link key={to} to={to} onClick={close}
          aria-current={to === current ? 'location' : undefined} className="public-menu-shortcut">
          <Icon size={18} aria-hidden="true" />{label}
        </Link>)}
      </section>}
      <div className="public-menu-groups">
        {groups.map(group => <section key={group.title} aria-label={group.title}>
          <h3>{group.title}</h3>
          {group.links.map(({ to, label, icon: Icon }) => <Link key={to} to={to} onClick={close}
            aria-current={to === current ? 'page' : undefined} className="public-menu-link">
            <Icon aria-hidden="true" size={18} /><span>{label}</span><ArrowUpRight aria-hidden="true" size={15} />
          </Link>)}
        </section>)}
      </div>
      <button type="button" className="public-menu-details" aria-expanded={detailsOpen} aria-controls="gym-details"
        onClick={() => setDetailsOpen(value => !value)}><Clock3 size={18} aria-hidden="true" />Next class &amp; gym details<ChevronDown size={17} aria-hidden="true" /></button>
      <div id="gym-details" hidden={!detailsOpen}>
        {detailsOpen && <Suspense fallback={<p role="status">Loading gym details…</p>}><MenuInformation user={user} profile={profile} close={close} /></Suspense>}
      </div>
    </div>
    <footer className="public-menu-footer">
      <Link to={user ? '/account' : '/login'} onClick={close} className="public-menu-account"><UserRound size={18} aria-hidden="true" />{user ? 'My account' : 'Log in'}</Link>
      {!user && <Link to="/register" onClick={close} className="public-menu-account">Join XERT</Link>}
      <Link to="/booking" onClick={close} className="public-nav-book">Book a class<ArrowRight size={16} aria-hidden="true" /></Link>
    </footer>
  </dialog>;
}
