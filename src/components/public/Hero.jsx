import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useSiteContent } from '@/lib/siteContent';
import { HERO_DEFAULTS, HERO_PHOTOS } from '@/lib/contentDefaults';

const LOGO_FULL_WHITE = '/assets/xert-logo-horizontal-light.png';

const VALUES = ['Discipline', 'Structure', 'Purpose', 'Performance', 'Movement Quality', 'Longevity', 'Community', 'Preparation'];

const STATS = [
  { label: 'Coached Model', value: 'Semi-private' },
  { label: 'Programming', value: '12-week blocks' },
  { label: 'Location', value: 'Kingaroy QLD' },
];

const DESKTOP_QUERY = '(min-width: 1024px)';

export default function Hero() {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia?.(DESKTOP_QUERY).matches ?? true);
  const bgRef = useRef(null);
  const contentRef = useRef(null);
  const overlayRef = useRef(null);
  const content = useSiteContent('hero', HERO_DEFAULTS);
  const headlineWords = (content.headline || HERO_DEFAULTS.headline).split(' ');
  const photos = content.photos?.length > 0 ? content.photos : HERO_PHOTOS;
  const idx = photoIndex % photos.length;

  useEffect(() => {
    if (photos.length <= 1) return undefined;
    const t = setInterval(() => setPhotoIndex(i => (i + 1) % photos.length), 5000);
    return () => clearInterval(t);
  }, [photos.length]);

  // Feature photo is desktop-only — skip rendering (and downloading) it on mobile.
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP_QUERY);
    if (!mq) return undefined;
    const onChange = e => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Scroll parallax — writes transforms/opacity straight to the DOM via refs
  // so scrolling never re-renders the component tree.
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = Math.min(window.scrollY, 800);
      const bgY = Math.min(160, y * 0.2);
      const contentY = -Math.min(60, y * 0.1);
      const overlayOpacity = Math.max(0.4, 1 - y * 0.0012);
      if (bgRef.current) bgRef.current.style.transform = `translate3d(0,${bgY}px,0)`;
      if (contentRef.current) contentRef.current.style.transform = `translate3d(0,${contentY}px,0)`;
      if (overlayRef.current) overlayRef.current.style.opacity = String(overlayOpacity);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="relative min-h-screen flex flex-col overflow-hidden bg-xert-navy">
      {/* Background photo with parallax + blue-steel grade */}
      <div ref={bgRef} className="absolute inset-0 will-change-transform" style={{ transform: 'translate3d(0,0,0)' }}>
        {photos.map((src, i) => (
          <div
            key={src}
            className="absolute inset-0 transition-opacity"
            style={{ opacity: i === idx ? 1 : 0, transitionDuration: '1400ms' }}
          >
            <img
              src={src}
              alt=""
              loading={i === 0 ? 'eager' : 'lazy'}
              decoding="async"
              className="w-full h-full object-cover object-center scale-110"
              style={{ filter: 'saturate(0.5) brightness(0.38)' }}
            />
          </div>
        ))}
      </div>

      {/* Grade overlays — one node so the parallax fades them together. On
          phones the darkness pools at the bottom so copy and CTAs sit on ink;
          desktop keeps the diagonal steel grade. */}
      <div ref={overlayRef} className="absolute inset-0" style={{ opacity: 1 }}>
        <div
          className="absolute inset-0 lg:hidden"
          style={{ background: 'linear-gradient(180deg, var(--surface-base-50) 0%, var(--surface-base-60) 28%, var(--surface-base-90) 58%, var(--surface-base-99) 100%)' }}
        />
        <div
          className="absolute inset-0 hidden lg:block"
          style={{ background: 'linear-gradient(160deg, var(--surface-base-92) 0%, var(--surface-secondary-60) 50%, var(--surface-base-97) 100%)' }}
        />
      </div>

      {/* Soft steel atmosphere */}
      <div aria-hidden="true" className="xert-glow-top absolute inset-0 pointer-events-none" />

      {/* Top fine animated line */}
      <div
        className="xert-hero-line absolute top-0 left-0 right-0 h-0.5 origin-left"
        style={{ background: 'linear-gradient(90deg, transparent, var(--accent-default), transparent)' }}
      />

      {/* Nav spacer */}
      <div className="relative z-10 shrink-0" style={{ height: 'calc(max(var(--nav-height-expanded), var(--public-nav-control-height, 0px)) + var(--public-announcement-height, 0px) + env(safe-area-inset-top))' }} />

      {/* Main hero content */}
      <div ref={contentRef} className="relative z-10 flex-1 flex flex-col justify-center px-6 pt-4 pb-8 sm:px-10 sm:pt-8 sm:pb-16 lg:px-16 will-change-transform" style={{ transform: 'translate3d(0,0,0)' }}>
        <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">

          {/* Left — brand + copy */}
          <div>
            <div className="xert-enter xert-enter-up mb-5 sm:mb-8">
              <img
                src={LOGO_FULL_WHITE}
                alt="XERT Fitness"
                className="h-12 w-auto object-contain sm:h-20"
              />
            </div>

            <div className="xert-enter xert-enter-left mb-4 flex min-w-0 items-start gap-3 sm:mb-6" style={{ animationDelay: '150ms' }}>
              <div className="mt-2 h-px w-6 shrink-0 bg-xert-steel" />
              <span className="min-w-0 font-body text-xs uppercase leading-relaxed tracking-[0.2em] text-xert-steel sm:tracking-[0.25em]">Functional Fitness Training Facility</span>
            </div>

            {/* Headline — line-by-line reveal */}
            <h1 className="mb-4 overflow-hidden font-display text-[clamp(3rem,10vw,7rem)] uppercase leading-[0.9] tracking-tight text-xert-offwhite sm:mb-6">
              {headlineWords.map((line, i) => (
                <span key={`${line}-${i}`} className="block overflow-hidden">
                  <span className="xert-headline-enter block" style={{ color: i === headlineWords.length - 1 ? 'var(--accent-default)' : undefined, animationDelay: `${200 + i * 120}ms` }}>
                    {line}
                  </span>
                </span>
              ))}
            </h1>

            <div className="xert-enter xert-enter-up" style={{ animationDelay: '600ms' }}>
              <p className="mb-3 font-body text-base leading-relaxed text-xert-pale sm:text-lg" style={{ maxWidth: '40ch' }}>
                {content.subheading}
              </p>
              <p className="mb-5 font-body text-sm leading-relaxed text-xert-steel sm:mb-7" style={{ maxWidth: '38ch' }}>
                {content.supporting}
              </p>

              <div className="mb-6 flex flex-col items-start gap-2.5 sm:mb-8 sm:flex-row sm:items-center sm:gap-4">
                <span className="xert-chip max-w-full" style={{ letterSpacing: '0.1em' }}>
                  <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-xert-steel animate-pulse" />
                  <span className="min-w-0 leading-snug">Booking-based semi-private classes</span>
                </span>
                <span className="font-body text-xs text-xert-pale/50">Class sizes shown for each session</span>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link to="/booking"
                  className="xert-btn-primary inline-flex min-h-[52px] w-full items-center justify-center px-8 py-3.5 font-display text-lg uppercase tracking-wide sm:w-auto sm:py-4">
                  Book Your First Session
                </Link>
                <Link to="/timetable"
                  className="xert-btn-ghost inline-flex min-h-[52px] w-full items-center justify-center px-8 py-3.5 font-display text-lg uppercase tracking-wide sm:w-auto sm:py-4">
                  View Timetable
                </Link>
              </div>
            </div>
          </div>

          {/* Right — feature photo (desktop only; not rendered on mobile so it never downloads there) */}
          {isDesktop && (
            <div className="xert-feature-enter hidden lg:block relative" style={{ animationDelay: '300ms' }}>
              <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-xert-steel/20 shadow-[0_30px_80px_-30px_var(--surface-scrim-80)]">
                <img
                  src={photos[idx]}
                  alt="XERT Training"
                  decoding="async"
                  className="w-full h-full object-cover transition-opacity duration-1000"
                  style={{ filter: 'saturate(0.7) brightness(0.75)' }}
                />
                <div className="absolute inset-0"
                  style={{ background: 'linear-gradient(180deg, var(--surface-base-30) 0%, transparent 40%, var(--surface-base-70) 100%)' }}
                />
                <div className="absolute bottom-5 left-5 right-16">
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-xert-steel/40" />
                    <span className="font-body text-xs uppercase tracking-widest text-xert-steel">Kingaroy, QLD</span>
                  </div>
                </div>
                {/* Photo index dots */}
                <div className="absolute top-5 right-5 flex flex-col gap-1.5">
                  {photos.map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full transition-all duration-500"
                      style={{ backgroundColor: i === idx ? 'var(--accent-default)' : 'var(--accent-default-25)' }} />
                  ))}
                </div>
              </div>
              <div className="absolute -right-4 top-1/2 -translate-y-1/2 font-display text-[5rem] leading-none uppercase -rotate-90 origin-right"
                style={{ color: 'var(--accent-default-6)', whiteSpace: 'nowrap' }}>
                Beat Your Best
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Values marquee + stats: one rounded glass strip */}
      <div className="relative z-10 px-4 pb-4 sm:px-6 sm:pb-6">
        <div className="xert-glass mx-auto max-w-6xl overflow-hidden rounded-2xl shadow-[0_24px_60px_-30px_var(--surface-scrim-85)]">
          <div
            className="overflow-hidden py-3"
            style={{
              maskImage: 'linear-gradient(90deg, transparent, black 8%, black 92%, transparent)',
              WebkitMaskImage: 'linear-gradient(90deg, transparent, black 8%, black 92%, transparent)',
            }}
          >
            <div className="xert-marquee-track flex whitespace-nowrap">
              {[0, 1].map(dup => (
                <div key={dup} className="flex items-center shrink-0" aria-hidden={dup === 1 ? 'true' : undefined}>
                  {/* VALUES twice per half so each half outruns wide viewports —
                      the -50% loop is only seamless when half-width >= container. */}
                  {[...VALUES, ...VALUES].map((v, i) => (
                    <React.Fragment key={`${v}-${i}`}>
                      <span className="font-display text-sm uppercase tracking-[0.15em] py-1" style={{ color: i % 2 === 0 ? 'var(--text-secondary)' : 'var(--accent-default)' }}>{v}</span>
                      <span className="mx-4 text-xert-steel/25">·</span>
                    </React.Fragment>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div aria-hidden="true" className="xert-divider" />

          {/* Stats */}
          <div className="grid grid-cols-3 divide-x divide-[var(--accent-default-16)] px-4 py-4 sm:px-6 sm:py-5">
            {STATS.map((stat, i) => (
              <div key={i} className={`px-3 sm:px-6 ${i === 0 ? 'pl-0 sm:pl-0' : ''} ${i === 2 ? 'pr-0 sm:pr-0' : ''}`}>
                <p className="mb-1 font-body text-[10px] uppercase tracking-wider text-xert-steel sm:text-xs">{stat.label}</p>
                <p className="font-display text-base uppercase leading-tight text-xert-offwhite sm:text-xl">{stat.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Scroll cue */}
      <div className="xert-scroll-cue absolute bottom-[11.5rem] left-1/2 -translate-x-1/2 z-10 hidden sm:flex flex-col items-center gap-2">
        <span className="font-body text-[10px] uppercase tracking-[0.3em] text-xert-steel/60">Scroll</span>
        <div
          className="xert-scroll-pulse w-px h-8 origin-top"
          style={{ background: 'linear-gradient(180deg, var(--accent-default), transparent)' }}
        />
      </div>
    </section>
  );
}
