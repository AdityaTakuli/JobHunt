// Companies (firms ArchJobs follows for everyone) and Firms (her own list to cold-email) are one
// place in the navigation: "Firms". This switch at the top moves between the two.

const TABS = [
  ['companies', 'Hiring companies', 'Firms ArchJobs checks for open roles'],
  ['firms', 'My firm list', 'Studios you plan to contact'],
];

export default function FirmsTabs({ current }) {
  return (
    <nav className="segmented firms-tabs" aria-label="Firms">
      {TABS.map(([path, label, hint]) => (
        <a key={path} href={`#/${path}`} aria-current={current === path ? 'page' : undefined} title={hint}>
          {label}
        </a>
      ))}
    </nav>
  );
}
