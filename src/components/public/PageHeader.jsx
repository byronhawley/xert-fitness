import React from 'react';

/**
 * Shared interior-page header: eyebrow rule, Bebas display headline with an
 * optional steel accent word, optional intro paragraph, and the same soft
 * steel glow as the home hero so interior pages carry the same voice.
 * Entrance motion reuses the existing xert-enter classes (reduced-motion safe).
 */
export default function PageHeader({
  eyebrow,
  title,
  accent = '',
  intro = '',
  containerClassName = 'max-w-5xl',
  children = null,
}) {
  return (
    <header className="relative overflow-hidden pb-4" style={{ paddingTop: 'calc(var(--public-nav-offset) + var(--space-section) + var(--space-inline) / 2)' }}>
      <div aria-hidden="true" className="xert-glow-top absolute inset-0 pointer-events-none" />
      <div className={`relative ${containerClassName} mx-auto px-6`}>
        <div className="mb-5 flex items-center gap-3 xert-enter xert-enter-left">
          <div className="h-px w-6 bg-xert-steel" />
          <span className="font-body text-xs uppercase tracking-[0.2em] text-xert-steel">{eyebrow}</span>
        </div>
        <h1
          className="font-display uppercase text-xert-offwhite xert-enter xert-enter-up"
          style={{ fontSize: 'clamp(2.5rem,7vw,4.5rem)', lineHeight: 0.95 }}
        >
          {title}
          {accent ? <span className="text-xert-steel"> {accent}</span> : null}
        </h1>
        {intro ? (
          <p
            className="mt-5 max-w-2xl font-body leading-relaxed text-xert-pale/80 xert-enter xert-enter-up"
            style={{ fontSize: '1.0625rem', animationDelay: '120ms' }}
          >
            {intro}
          </p>
        ) : null}
        {children}
      </div>
    </header>
  );
}
