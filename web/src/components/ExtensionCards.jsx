// Profile page: where to get ARCH in Chrome and what it does.

export function ExtensionCard({ fillsToday, fillsPerDay }) {
  return (
    <section className="card profile-section extension-card">
      <div className="extension-head">
        <span className="extension-mark" aria-hidden="true">
          A
        </span>
        <div>
          <h3>ARCH in Chrome</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Fills a job application when you ask it to: press Fill with ARCH on the form, or Alt+Shift+A. It never fills other sites by itself and never presses submit.
          </p>
        </div>
      </div>
      <ul className="small extension-points">
        <li>
          <strong>Name, contact, address, college, marks, pay, notice period</strong> come straight from your application details above (blue outline).
        </li>
        <li>
          <strong>Your CV and portfolio PDFs</strong> are attached to the upload boxes for you (My CV when you haven't uploaded one).
        </li>
        <li>
          <strong>Open questions</strong> ("Why this firm?", "Your Revit experience") are drafted by AI from your CV and that posting (amber outline: read them). Pay, notice period, marks and
          gender are never guessed: only what you saved in your details.
        </li>
        <li>
          <strong>Postings ArchJobs can't read</strong> (Glassdoor): open one with ARCH installed and it sends the posting here, so "Analyse" reads the real requirements.
        </li>
      </ul>
      <ol className="small extension-steps">
        <li>
          <a className="btn btn-primary btn-sm" href="/api/extension.zip" download>
            Download ARCH in Chrome
          </a>{' '}
          and unzip it.
        </li>
        <li>
          Open <code>chrome://extensions</code>, switch on <strong>Developer mode</strong> (top right), click <strong>Load unpacked</strong> and pick the <code>arch-in-chrome</code> folder.
        </li>
        <li>
          Stay signed in to ArchJobs in Chrome. On an application form, click <strong>Fill with ARCH</strong> or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.
        </li>
      </ol>
      {fillsPerDay ? (
        <p className="small muted" style={{ margin: 0 }}>
          AI answers today: {fillsToday} of {fillsPerDay}. Fields filled straight from your details don't count.
        </p>
      ) : null}
    </section>
  );
}
