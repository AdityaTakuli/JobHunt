import ProfilePanel from '../components/ProfilePanel.jsx';

// "Profile" in the main nav: upload the CV and portfolio, see what the AI read and the fit gaps.
export default function ProfilePage() {
  return (
    <div className="page-wide settings profile-page">
      <header className="settings-head">
        <div>
          <h1>Your profile</h1>
          <p>Your CV and/or portfolio, and the details application forms ask for. Every job is scored against them.</p>
        </div>
      </header>
      <ProfilePanel />
    </div>
  );
}
