// How well a job fits the person's CV and portfolio (server lib/fit.js): a small badge on the
// card, and the full breakdown in the details.

export const VERDICT_LABELS = { strong: 'Strong fit', possible: 'Possible fit', stretch: 'Stretch' };

export function FitBadge({ fit, compact = false }) {
  if (!fit) return null;
  return (
    <span className={`fit-badge is-${fit.verdict}`} title={`${VERDICT_LABELS[fit.verdict]}: ${fit.score}/100 against your profile`}>
      <strong>{fit.score}</strong>
      {!compact && <span>{VERDICT_LABELS[fit.verdict]}</span>}
    </span>
  );
}

const EVIDENCE = { shown: 'in portfolio', listed: 'on CV' };

export function FitSection({ fit }) {
  if (!fit) {
    return (
      <section className="detail-section">
        <h3>Your fit</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Upload your CV or portfolio in <a href="#/settings?tab=profile">Settings → Profile</a> to see how well each role fits you.
        </p>
      </section>
    );
  }
  const required = fit.missing.filter((m) => m.required);
  const preferred = fit.missing.filter((m) => !m.required);
  return (
    <section className="detail-section fit-section">
      <h3>Your fit</h3>
      <div className="fit-head">
        <FitBadge fit={fit} />
        <div className="fit-parts small muted">
          <span title="Required skills the posting names that you have">Required {fit.parts.required}%</span>
          <span title="Tools named, portfolio evidence counts in full">Tools {fit.parts.tools}%</span>
          <span title="Internship / fresher / experienced vs where you are">Level {fit.parts.level}%</span>
          <span title="Does your portfolio show this kind of work">Portfolio {fit.parts.portfolio}%</span>
        </div>
      </div>
      {fit.notes.length > 0 && (
        <ul className="fit-notes small">
          {fit.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {fit.matched.length > 0 && (
        <div className="fit-row">
          <span className="fit-label small muted">You have</span>
          <div className="fit-chips">
            {fit.matched.map((m) => (
              <span key={m.label} className={`fit-chip is-have${m.evidence === 'shown' ? ' is-shown' : ''}`} title={m.evidence ? EVIDENCE[m.evidence] : ''}>
                {m.label}
                {m.evidence === 'shown' && <small> · shown</small>}
              </span>
            ))}
          </div>
        </div>
      )}
      {required.length > 0 && (
        <div className="fit-row">
          <span className="fit-label small muted">Asked for, missing</span>
          <div className="fit-chips">
            {required.map((m) => (
              <span key={m.label} className="fit-chip is-missing">
                {m.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {preferred.length > 0 && (
        <div className="fit-row">
          <span className="fit-label small muted">Nice to have, missing</span>
          <div className="fit-chips">
            {preferred.map((m) => (
              <span key={m.label} className="fit-chip is-preferred">
                {m.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {fit.improvements.length > 0 && (
        <div className="fit-improve">
          <p className="small" style={{ margin: '0 0 4px', fontWeight: 600 }}>
            To improve your chances here
          </p>
          <ul className="small">
            {fit.improvements.map((i) => (
              <li key={i.label}>
                <strong>{i.label}</strong>
                {i.required ? '' : ' (nice to have)'}: {i.tip}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
