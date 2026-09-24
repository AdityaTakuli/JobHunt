// The ArchJobs mark: an isometric building block (a BIM model, floors stacked) with its roof
// picked out in the accent. The tile inverts with the theme so it always reads as one mark.
export function LogoMark({ size = 28, className = '' }) {
  return (
    <span className={`logo-mark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="3.5 3 25 25" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round">
        <path className="logo-key" d="M16 5.5 25 10.5 16 15.5 7 10.5Z" />
        <path d="M7 10.5v11L16 26.5l9-5v-11M16 15.5v11" />
        <path d="M7 16l9 5 9-5" strokeWidth="1.3" />
      </svg>
    </span>
  );
}

export default function Logo({ size = 28 }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">ArchJobs</span>
    </span>
  );
}
