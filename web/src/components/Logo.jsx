// The ArchJobs mark: the pavilion from the login drawing reduced to a few lines, floor slabs in
// the accent. It sketches itself when it first appears (CSS stroke-dashoffset on paths with
// pathLength=1), and simply shows drawn when motion is reduced.
const LINES = [
  { d: 'M2 29.5H46' }, // ground
  { d: 'M12 29.5V18.5H33V29.5' }, // glazed ground floor
  { d: 'M19 18.5V29.5M26 18.5V29.5', className: 'lm-thin' }, // mullions
  { d: 'M5 18.5H43', className: 'lm-slab' }, // cantilevered first-floor slab
  { d: 'M9 18.5V9H31V18.5' }, // upper floor
  { d: 'M7 9H33', className: 'lm-slab' }, // roof slab
  { d: 'M39 18.5V29.5' }, // column under the cantilever
];

export function LogoMark({ width = 44, animate = true, className = '' }) {
  return (
    <svg
      className={`logo-mark${animate ? ' is-drawing' : ''} ${className}`}
      width={width}
      height={(width * 32) / 48}
      viewBox="0 0 48 32"
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

export default function Logo({ width = 44 }) {
  return (
    <span className="logo">
      <LogoMark width={width} />
      <Wordmark />
    </span>
  );
}
