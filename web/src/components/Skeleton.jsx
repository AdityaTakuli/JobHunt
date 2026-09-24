import { motion } from 'motion/react';
import { randomQuote } from '../quotes.js';
import { useState } from 'react';

// Placeholder block with a soft highlight sweeping across it. Each block runs its own sweep;
// `delay` staggers neighbours so a list shimmers as a wave instead of all at once.
export function Shimmer({ width = '100%', height = 12, radius = 6, delay = 0, style }) {
  return (
    <span className="shimmer" style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true">
      <motion.span
        className="shimmer-glint"
        initial={{ x: '-100%' }}
        animate={{ x: '100%' }}
        transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.3, delay }}
      />
    </span>
  );
}

// Same shape as a JobCard: title, company line, meta, badges and buttons.
export function JobCardSkeleton({ index = 0 }) {
  const d = index * 0.12;
  return (
    <li className="card job-card skeleton-card" aria-hidden="true">
      <Shimmer width="62%" height={16} delay={d} />
      <Shimmer width="38%" height={12} delay={d + 0.05} />
      <div className="skeleton-row">
        <Shimmer width={90} height={12} delay={d + 0.1} />
        <Shimmer width={60} height={12} delay={d + 0.1} />
      </div>
      <div className="skeleton-row">
        <Shimmer width={48} height={22} radius={99} delay={d + 0.15} />
        <Shimmer width={56} height={22} radius={99} delay={d + 0.15} />
        <Shimmer width={64} height={22} radius={99} delay={d + 0.15} />
      </div>
      <div className="skeleton-row">
        <Shimmer width={74} height={32} radius={8} delay={d + 0.2} />
        <span style={{ flex: 1 }} />
        <Shimmer width={82} height={32} radius={8} delay={d + 0.2} />
      </div>
    </li>
  );
}

// A quote that only appears when loading is slow (after `after` ms), so fast loads never flash text.
export function LoadingQuote({ after = 700 }) {
  const [quote] = useState(randomQuote);
  return (
    <motion.p
      className="loading-quote"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: after / 1000, duration: 0.5 }}
    >
      “{quote.text}”{quote.by && <span> — {quote.by}</span>}
    </motion.p>
  );
}

export function JobListSkeleton({ count = 4, label = 'Loading jobs' }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <LoadingQuote />
      <ul className="job-list">
        {Array.from({ length: count }, (_, i) => (
          <JobCardSkeleton key={i} index={i} />
        ))}
      </ul>
    </div>
  );
}

// Generic stacked rows, for tables, settings and the tracker.
export function RowsSkeleton({ rows = 5, label = 'Loading' }) {
  return (
    <div className="card rows-skeleton" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <Shimmer width={`${40 + ((i * 17) % 35)}%`} height={14} delay={i * 0.1} />
          <span style={{ flex: 1 }} />
          <Shimmer width={70} height={14} delay={i * 0.1 + 0.05} />
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="detail-skeleton" aria-busy="true" aria-label="Loading job">
      <Shimmer width="80%" height={22} />
      <Shimmer width="45%" height={14} delay={0.05} />
      <div className="skeleton-row">
        <Shimmer width={56} height={22} radius={99} delay={0.1} />
        <Shimmer width={64} height={22} radius={99} delay={0.1} />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <Shimmer key={i} width={`${92 - ((i * 13) % 30)}%`} height={12} delay={0.15 + i * 0.05} />
      ))}
    </div>
  );
}
