import { useState } from 'react';
import { api } from '../api.js';

export default function LoginPage({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { method: 'POST', body: { password } });
      onLogin();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card">
        <form onSubmit={submit}>
          <div>
            <h1>ArchJobs</h1>
            <p>Architecture & BIM roles, in one place.</p>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
