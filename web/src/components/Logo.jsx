// The ArchJobs mark: two nested arches, the outer one in the accent and the inner one in the
// warm logo ink. It sketches itself when it first appears (CSS stroke-dashoffset on paths with
// pathLength=1), and simply shows drawn when motion is reduced.
const LINES = [
  { d: 'M4 32V13A10 10 0 0 1 24 13V32', className: 'lm-outer' },
  { d: 'M10 32V13A4 4 0 0 1 18 13V32', className: 'lm-inner' },
];

export function LogoMark({ height = 32, animate = true, className = '' }) {
  return (
    <svg
      className={`logo-mark${animate ? ' is-drawing' : ''} ${className}`}
      width={(height * 28) / 32}
      height={height}
      viewBox="0 0 28 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {LINES.map((line, i) => (
        <path key={line.d} d={line.d} pathLength="1" className={line.className} style={{ '--i': i }} />
      ))}
    </svg>
  );
}

export function Wordmark({ className = '' }) {
  return (
    <span className={`logo-word ${className}`}>
      Arch<b>Jobs</b>
    </span>
  );
}

export default function Logo({ height = 32 }) {
  return (
    <span className="logo">
      <LogoMark height={height} />
      <Wordmark />
    </span>
  );
}
