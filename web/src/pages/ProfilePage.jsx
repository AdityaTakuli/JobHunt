import ProfilePanel from '../components/ProfilePanel.jsx';

// "Profile" in the main nav: upload the CV and portfolio, see what the AI read and the fit gaps.
export default function ProfilePage() {
  return (
    <div className="page-narrow settings">
      <header className="settings-head">
        <div>
          <h1>Your profile</h1>
          <p>Your CV and portfolio. Every job is scored against them.</p>
        </div>
      </header>
      <ProfilePanel />
    </div>
  );
}
