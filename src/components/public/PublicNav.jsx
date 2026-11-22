import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, CalendarCheck, CalendarDays, CalendarRange, ChartNoAxesColumnIncreasing, Compass, Dumbbell, House, LayoutGrid, MapPin, PanelsTopLeft, Ticket, UsersRound, UserRound } from 'lucide-react';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { usePtAvailability } from '@/lib/usePtAvailability';
import MobileSheet from './nav/MobileSheet';
import './nav/public-nav.css';

const training = [
  { to: '/timetable', label: 'Timetable', icon: CalendarDays },
  { to: '/memberships', label: 'Memberships & Passes', icon: Ticket },
  { to: '/coaches', label: 'Coaches', icon: UsersRound },
];
const personalTraining = { to: '/pt', label: 'Personal Training', icon: Dumbbell };
const memberLinks = [
  { to: '/account#bookings', label: 'Upcoming classes', icon: CalendarCheck },
  { to: '/account#progress', label: 'Training progress', icon: ChartNoAxesColumnIncreasing },
];
const ownerLink = { to: '/admin', label: 'Command centre', icon: PanelsTopLeft };
const gym = [
  { to: '/', label: 'Home', icon: House },
  { to: '/#facility', label: 'Facility', icon: Compass },
  { to: '/events', label: 'Events', icon: CalendarRange },
  { to: '/contact', label: 'Contact', icon: MapPin },
];

export default function PublicNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef(null);
  const location = useLocation();
  const { session, profile, isAdmin } = useSupabaseAuth();
  const pt = usePtAvailability();
  const close = useCallback(() => setMenuOpen(false), []);
  useEffect(() => { close(); }, [location, close]);

  return <nav data-public-nav aria-label="Main navigation" className="public-nav" data-menu-open={menuOpen}>
    <a href="#main" className="public-nav-skip">Skip to content</a>
    <div className="public-nav-bar">
      <Link to="/" aria-label="XERT Fitness home" className="public-nav-logo"><img src="/assets/xert-logo-horizontal-light.png" alt="XERT Fitness" /></Link>
      <div className="public-nav-links">
        {training.map(link => <Link key={link.to} to={link.to} aria-current={location.pathname === link.to ? 'page' : undefined}
          className="public-nav-link">{link.label}</Link>)}
      </div>
      <div className="public-nav-actions">
        <Link to={session ? '/account' : '/login'} className="public-nav-account"><UserRound aria-hidden="true" size={17} />{session ? 'Account' : 'Log in'}</Link>
        <Link to="/booking" aria-label="Book a class" className="public-nav-book">Book<span className="public-nav-book-long"> a class</span><ArrowUpRight aria-hidden="true" size={16} /></Link>
        <button ref={triggerRef} type="button" onClick={() => setMenuOpen(value => !value)}
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={menuOpen} aria-controls="mobile-navigation" aria-haspopup="dialog"
          className="public-nav-trigger min-w-11 min-h-11"><LayoutGrid aria-hidden="true" size={18} /><span>Menu</span></button>
      </div>
    </div>
    {menuOpen && <MobileSheet shortcuts={session ? (isAdmin ? [...memberLinks, ownerLink] : memberLinks) : []}
      groups={[{ title: 'Training', links: pt.enabled ? [...training, personalTraining] : training }, { title: 'The gym', links: gym }]}
      current={location.pathname + location.hash} user={session?.user} profile={profile} close={close} triggerRef={triggerRef} />}
  </nav>;
}
