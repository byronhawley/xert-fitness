import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import DesktopLinks from './nav/DesktopLinks';
import MobileSheet from './nav/MobileSheet';
import NavLink from './nav/NavLink';
import useNavScroll from './nav/useNavScroll';
import { navDesktopMediaQuery } from './nav/navTokens';
import { usePtAvailability } from '@/lib/usePtAvailability';
import './nav/public-nav.css';

const LOGO = '/assets/xert-logo-horizontal-light.png';
const BASE_LINKS = [
  { to: '/', label: 'Home' }, { href: '/#facility', label: 'Facility' },
  { to: '/timetable', label: 'Timetable' }, { to: '/memberships', label: 'Memberships & Passes' },
  { to: '/coaches', label: 'Coaches' },
  { to: '/events', label: 'Events' }, { to: '/contact', label: 'Contact' },
];
const PT_LINK = { to: '/pt', label: 'Personal Training' };

export default function PublicNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef(null);
  const navRef = useRef(null);
  const [desktopFits, setDesktopFits] = useState(false);
  const location = useLocation();
  const { session, profile } = useSupabaseAuth();
  const pt = usePtAvailability();
  const links = pt.enabled ? BASE_LINKS.flatMap(link => link.to === '/coaches' ? [link, PT_LINK] : [link]) : BASE_LINKS;
  const close = useCallback(() => setMenuOpen(false), []);
  useNavScroll();
  useEffect(() => { close(); }, [location, close]);
  useLayoutEffect(() => {
    const bar = navRef.current.querySelector('.public-nav-bar');
    const desktop = navRef.current.querySelector('.public-nav-desktop');
    const logo = navRef.current.querySelector('.public-nav-logo img');
    const trigger = triggerRef.current;
    const mq = window.matchMedia(navDesktopMediaQuery());
    const measure = () => {
      const style = getComputedStyle(bar);
      const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const expandedLogoHeight = parseFloat(getComputedStyle(logo).getPropertyValue('--nav-logo-expanded'));
      const logoWidth = logo.naturalHeight ? logo.naturalWidth / logo.naturalHeight * expandedLogoHeight : logo.getBoundingClientRect().width;
      const fits = mq.matches && desktop.scrollWidth + logoWidth + parseFloat(style.columnGap) <= available;
      const controlHeight = fits ? desktop.getBoundingClientRect().height : trigger.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--public-nav-control-height', `${controlHeight}px`);
      setDesktopFits(fits);
      if (fits) close();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    observer.observe(desktop);
    observer.observe(logo);
    observer.observe(trigger);
    mq.addEventListener('change', measure);
    measure();
    return () => { observer.disconnect(); mq.removeEventListener('change', measure); };
  }, [close]);
  return <nav ref={navRef} data-public-nav data-desktop={desktopFits} aria-label="Main navigation" className="public-nav" data-menu-open={menuOpen} data-interior={location.pathname !== '/'}>
    <a href="#main" className="public-nav-skip">Skip to content</a>
    <div className="public-nav-bar">
      <NavLink to="/" aria-label="XERT Fitness home" className="public-nav-logo"><img src={LOGO} alt="XERT Fitness" /></NavLink>
      <DesktopLinks links={links} pathname={location.pathname} signedIn={Boolean(session)} visible={desktopFits} />
      <button ref={triggerRef} type="button" onClick={() => setMenuOpen(value => !value)}
        aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={menuOpen} aria-controls="mobile-navigation"
        className="public-nav-trigger min-w-11 min-h-11"><span aria-hidden="true">{menuOpen ? '×' : '☰'}</span><span>Menu</span></button>
    </div>
    <span className="public-nav-progress" aria-hidden="true" />
    {menuOpen && <MobileSheet links={links} pathname={location.pathname} user={session?.user} profile={profile} close={close} triggerRef={triggerRef} />}
  </nav>;
}
