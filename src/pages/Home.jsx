import React, { useEffect, useRef, useState } from 'react';
import PublicNav from '@/components/public/PublicNav';
import Hero from '@/components/public/Hero';
import Countdown from '@/components/public/Countdown';
import PairsCompPromo from '@/components/public/PairsCompPromo';
import WhatXertIs from '@/components/public/WhatXertIs';
import EventWall from '@/components/public/EventWall';
import TrainingStyle from '@/components/public/TrainingStyle';
import AudienceRows from '@/components/public/AudienceRows';
import FacilitySection from '@/components/public/FacilitySection';
import FounderSection from '@/components/public/FounderSection';
import HowToTrain from '@/components/public/HowToTrain';
import EoiSelector from '@/components/public/EoiSelector';
import FAQ from '@/components/public/FAQ';
import PublicFooter from '@/components/public/PublicFooter';
import StickyMobileCTA from '@/components/public/StickyMobileCTA';
import Marquee from '@/components/public/Marquee';
import Reveal from '@/components/public/motion/Reveal';
import PWAInstallPrompt from '@/components/public/PWAInstallPrompt';
import { getSoftLaunchSettings, getDefaultSettings } from '@/lib/adminData';
import { DEFAULT_TARGET_LAUNCH_DATE } from '@/lib/launchSettings';

export default function Home() {
  const [settings, setSettings] = useState(getDefaultSettings());
  const homeRef = useRef(null);
  const bannerRef = useRef(null);

  useEffect(() => {
    getSoftLaunchSettings().then(s => { if (s) setSettings(s); }).catch(() => {});
  }, []);

  useEffect(() => {
    const home = homeRef.current;
    const banner = bannerRef.current;
    if (!banner) { home.style.setProperty('--public-announcement-height', '0px'); return; }
    const measure = () => home.style.setProperty('--public-announcement-height', `${banner.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    measure();
    return () => observer.disconnect();
  }, [settings.announcement_banner_enabled, settings.announcement_banner_text]);

  return (
    <div ref={homeRef} className="min-h-screen bg-xert-navy">
      <PublicNav />

      {settings.announcement_banner_enabled && settings.announcement_banner_text && (
        <div ref={bannerRef} data-public-announcement className="fixed left-0 right-0 z-30 py-2 px-4 text-center"
          style={{ top: 'var(--public-nav-offset)', backgroundColor: 'var(--surface-secondary)' }}>
          <p className="font-body text-sm text-xert-offwhite">{settings.announcement_banner_text}</p>
        </div>
      )}

      <main id="main">
        <Hero />
        <PairsCompPromo />
        <Countdown
          targetDate={settings.target_launch_date || DEFAULT_TARGET_LAUNCH_DATE}
          enabled={settings.countdown_enabled !== false}
        />

        <Marquee />

        <Reveal><WhatXertIs /></Reveal>
        <Reveal><TrainingStyle /></Reveal>
        <Reveal><FacilitySection /></Reveal>
        <Reveal><EventWall /></Reveal>
        <Reveal><AudienceRows /></Reveal>

        <Marquee />

        <Reveal><FounderSection /></Reveal>
        <Reveal><HowToTrain /></Reveal>
        <Reveal><EoiSelector /></Reveal>

        {/* Final CTA */}
        <Reveal>
          <section className="xert-glow-center relative overflow-hidden bg-xert-navy px-6 py-14 text-center sm:py-20">
            <div aria-hidden="true" className="xert-divider absolute top-0 left-0 right-0" />
            <div aria-hidden="true" className="xert-grid-faint absolute inset-0 pointer-events-none" />
            <div className="relative mx-auto max-w-xl">
              <h2 className="mb-4 font-display uppercase text-xert-offwhite" style={{ fontSize: 'clamp(2rem,5vw,3rem)' }}>
                Book your first session.
              </h2>
              <p className="mx-auto mb-8 max-w-[40ch] font-body text-base leading-relaxed text-xert-pale/65">
                Contact XERT to learn more about the coaching system, memberships and the training block that fits your next goal.
              </p>
              <a href="/booking"
                className="xert-btn-primary inline-flex min-h-[52px] w-full items-center justify-center px-8 py-4 font-display text-lg uppercase sm:w-auto">
                Book Your First Session
              </a>
            </div>
          </section>
        </Reveal>

        <Reveal><FAQ /></Reveal>
      </main>

      <PublicFooter />
      <StickyMobileCTA />
      <PWAInstallPrompt />
    </div>
  );
}
