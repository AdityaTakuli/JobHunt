// Companies (the MNCs ArchJobs tracks for everyone) and her own firm list are one place in the
// navigation: "Companies". This switch at the top moves between the two.

const TABS = [
  ['companies', 'Companies', 'MNCs ArchJobs checks for open roles'],
  ['firms', 'My firm list', 'Studios you plan to contact'],
];

export default function FirmsTabs({ current }) {
  return (
    <nav className="segmented firms-tabs" aria-label="Companies">
      {TABS.map(([path, label, hint]) => (
        <a key={path} href={`#/${path}`} aria-current={current === path ? 'page' : undefined} title={hint}>
          {label}
        </a>
      ))}
    </nav>
  );
}
