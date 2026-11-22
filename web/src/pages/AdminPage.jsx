import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../App.jsx';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { formatDateTime } from '../format.js';

// Admin console: who uses ArchJobs, how and when, who pays and which coupons went where.
// Usage is the name of what someone pressed and when (lib/events.js), never what they typed.

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const shortDay = (iso) => new Date(`${iso}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
const date = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');

function ago(d) {
  if (!d) return 'never';
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days} d ago` : date(d);
}

// A big number with a small label: the headline figures.
function Stat({ label, value, note }) {
  return (
    <div className="adm-stat">
      <span className="adm-stat-label">{label}</span>
      <strong className="adm-stat-value">{value}</strong>
      {note && <span className="adm-stat-note">{note}</span>}
    </div>
  );
}

// Vertical bars, one series, bars rise from the baseline; each bar is focusable and says its value.
function Columns({ items, label }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="adm-cols" role="list" aria-label={label}>
      {items.map((i) => (
        <div key={i.key} className="adm-col" role="listitem" tabIndex={0} aria-label={i.tip} data-tip={i.tip}>
          <span className="adm-col-bar" style={{ height: `${Math.max(i.value ? 3 : 0, (i.value / max) * 100)}%` }} />
          {i.tick && <span className="adm-col-tick">{i.tick}</span>}
        </div>
      ))}
    </div>
  );
}

// Horizontal bars for a ranking, each with its count written out (no reading off an axis).
function Ranking({ items }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (!items.length) return <p className="adm-empty">Nothing yet in this period.</p>;
  return (
    <ul className="adm-rank">
      {items.map((i) => (
        <li key={i.name || i.feature}>
          <span className="adm-rank-label">{i.label}</span>
          <span className="adm-rank-track">
            <span className="adm-rank-bar" style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
          <span className="adm-rank-value">
            {num(i.count)} <small>· {num(i.users)} {i.users === 1 ? 'person' : 'people'}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PlanTag({ u }) {
  if (u.status === 'pro') return <span className="adm-tag is-pro">Pro until {date(u.until)}</span>;
  if (u.status === 'trial') return <span className="adm-tag is-trial">Trial until {date(u.until)}</span>;
  return <span className="adm-tag">Free</span>;
}

function UserDetail({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/admin/users/${id}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [id]);
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="adm-empty">Loading…</p>;
  return (
    <div className="adm-detail">
      <div>
        <h4>When they use it (India time)</h4>
        <Columns label="Their activity by hour" items={data.hours.map((v, h) => ({ key: h, value: v, tip: `${hourLabel(h)}: ${v}`, tick: h % 6 === 0 ? hourLabel(h) : null }))} />
        {data.payments.length > 0 && (
          <>
            <h4>Payments</h4>
            <ul className="adm-list">
              {data.payments.map((p, i) => (
                <li key={i}>
                  {date(p.paid_at || p.created_at)} · {p.plan} · {p.amount ? rupees(p.amount) : 'free'}
                  {p.coupon ? ` · ${p.coupon}` : ''} · {p.status}
                  {p.mode !== 'live' ? ` (${p.mode})` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div>
        <h4>Recent activity</h4>
        {data.timeline.length ? (
          <ul className="adm-list adm-timeline">
            {data.timeline.map((t, i) => (
              <li key={i} className={t.kind === 'work' ? 'is-work' : ''}>
                <span>{t.label}</span>
                <time>{formatDateTime(t.at)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="adm-empty">No activity recorded yet.</p>
        )}
      </div>
    </div>
  );
}

const SORTS = {
  lastSeen: (a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0),
  joined: (a, b) => new Date(b.joined || 0) - new Date(a.joined || 0),
  events: (a, b) => b.events - a.events,
  activeDays: (a, b) => b.activeDays - a.activeDays,
  logins: (a, b) => b.logins - a.logins,
  plan: (a, b) => ['pro', 'trial', 'free'].indexOf(a.status) - ['pro', 'trial', 'free'].indexOf(b.status),
};

export default function AdminPage() {
  const { me } = useMeta();
  const [days, setDays] = useState(30);
  const [withAdmins, setWithAdmins] = useState(false);
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState(null);
  const [payments, setPayments] = useState(null);
  const [error, setError] = useState('');
  const [find, setFind] = useState('');
  const [sort, setSort] = useState('lastSeen');
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    setError('');
    const q = `?days=${days}${withAdmins ? '&admins=1' : ''}`;
    Promise.all([api(`/admin/overview${q}`), api(`/admin/users${q}`), api('/admin/payments')])
      .then(([o, u, p]) => {
        setOverview(o);
        setUsers(u.users);
        setPayments(p.payments);
      })
      .catch((err) => setError(err.message));
  }, [days, withAdmins]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    if (!users) return [];
    const q = find.trim().toLowerCase();
    return users
      .filter((u) => withAdmins || !u.admin)
      .filter((u) => !q || `${u.name || ''} ${u.email || ''} ${u.coupons.join(' ')}`.toLowerCase().includes(q))
      .sort(SORTS[sort]);
  }, [users, find, sort, withAdmins]);

  if (me && !me.isAdmin) return <p className="form-error">Only admins can open this page.</p>;
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!overview || !users || !payments) return <RowsSkeleton rows={6} label="Loading the admin console" />;
  const t = overview.totals;
  const paid = payments.filter((p) => p.status === 'paid');

  return (
    <div className="page-wide adm">
      <header className="adm-head">
        <div>
          <h1>Admin console</h1>
          <p>How people use ArchJobs. Pages and buttons pressed and when, never what anyone types. Kept 180 days.</p>
        </div>
        <div className="adm-controls">
          <div className="segmented" role="group" aria-label="Period">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
          <label className="adm-check">
            <input type="checkbox" checked={withAdmins} onChange={(e) => setWithAdmins(e.target.checked)} /> Include admins
          </label>
          <button type="button" className="btn btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
      </header>

      <section className="adm-stats" aria-label="Headline numbers">
        <Stat label="People" value={num(t.users)} note={`${num(t.newUsers)} new in ${days} days`} />
        <Stat label="Active today" value={num(t.activeToday)} note="last 24 hours" />
        <Stat label="Active this week" value={num(t.active7)} note="last 7 days" />
        <Stat label="Active this month" value={num(t.active30)} note="last 30 days" />
        <Stat label="Paying Pro" value={num(t.pro)} note={`${num(t.trial)} on a free trial`} />
        <Stat label="Revenue" value={rupees(t.revenue)} note={`${rupees(t.revenueWindow)} in ${days} days · ${num(t.payments)} payments`} />
        <Stat label="Coupons used" value={num(t.couponsUsed)} />
      </section>

      <div className="adm-grid">
        <section className="card adm-card">
          <h2>Active people per day</h2>
          <p className="adm-sub">Different people who used the app each day, India time. Hover a bar for the day.</p>
          <Columns
            label="Active people per day"
            items={overview.daily.map((d, i) => ({
              key: d.day,
              value: d.users,
              tip: `${shortDay(d.day)}: ${d.users} active · ${d.events} actions · ${d.signups} joined`,
              tick: i === 0 || i === overview.daily.length - 1 || (days <= 30 && i % 7 === 0) ? shortDay(d.day) : null,
            }))}
          />
        </section>
        <section className="card adm-card">
          <h2>When they use it</h2>
          <p className="adm-sub">Actions by hour of the day, India time, over the last {days} days.</p>
          <Columns
            label="Actions by hour"
            items={overview.hours.map((h) => ({
              key: h.hour,
              value: h.events,
              tip: `${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}: ${h.events} actions by ${h.users} people`,
              tick: h.hour % 3 === 0 ? hourLabel(h.hour) : null,
            }))}
          />
        </section>
        <section className="card adm-card">
          <h2>What they press</h2>
          <p className="adm-sub">Pages opened and buttons pressed, most used first.</p>
          <Ranking items={overview.events} />
        </section>
        <section className="card adm-card">
          <h2>Work done for them</h2>
          <p className="adm-sub">Tailored CVs, fit checks, ARCH answers and profile reads that finished.</p>
          <Ranking items={overview.work} />
        </section>
      </div>

      <section className="card adm-card">
        <div className="adm-card-head">
          <div>
            <h2>People</h2>
            <p className="adm-sub">Click a person to see their recent activity and when they use the app.</p>
          </div>
          <div className="adm-controls">
            <input className="input adm-find" type="search" placeholder="Name, email or coupon" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a person" />
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort people">
              <option value="lastSeen">Last active</option>
              <option value="joined">Newest</option>
              <option value="events">Most actions</option>
              <option value="activeDays">Most active days</option>
              <option value="logins">Most sign-ins</option>
              <option value="plan">Pro first</option>
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table adm-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Plan</th>
                <th scope="col">Last active</th>
                <th scope="col">Joined</th>
                <th scope="col" className="num">Sign-ins</th>
                <th scope="col" className="num">Active days</th>
                <th scope="col" className="num">Actions</th>
                <th scope="col" className="num">CVs</th>
                <th scope="col" className="num">Fit checks</th>
                <th scope="col" className="num">ARCH</th>
                <th scope="col" className="num">Tracked</th>
                <th scope="col">Coupon</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <Fragment key={u.id}>
                  <tr className={`adm-row${open === u.id ? ' is-open' : ''}`} onClick={() => setOpen(open === u.id ? null : u.id)}>
                    <td>
                      <button type="button" className="adm-person" aria-expanded={open === u.id}>
                        <strong>{u.name || u.email || `Account ${u.id}`}</strong>
                        {u.name && u.email && <span>{u.email}</span>}
                      </button>
                    </td>
                    <td>
                      <PlanTag u={u} />
                    </td>
                    <td>{ago(u.lastSeen)}</td>
                    <td>{date(u.joined)}</td>
                    <td className="num">{num(u.logins)}</td>
                    <td className="num">{num(u.activeDays)}</td>
                    <td className="num">{num(u.events)}</td>
                    <td className="num">{num(u.work.tailor)}</td>
                    <td className="num">{num(u.work.analysis)}</td>
                    <td className="num">{num(u.work.fill)}</td>
                    <td className="num">{num(u.tracked)}</td>
                    <td>{[...u.coupons, u.hadTrial ? 'trial' : null].filter(Boolean).join(', ') || '—'}</td>
                  </tr>
                  {open === u.id && (
                    <tr className="adm-detail-row">
                      <td colSpan={12}>
                        <UserDetail id={u.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!shown.length && <p className="adm-empty">No one matches.</p>}
        <p className="adm-sub adm-foot">Actions, active days, CVs, fit checks and ARCH answers count the last {days} days; sign-ins and tracked roles are all-time.</p>
      </section>

      <section className="card adm-card">
        <h2>Payments and free activations</h2>
        <p className="adm-sub">
          {paid.length} completed · {payments.filter((p) => p.status === 'created').length} started but not paid · {payments.filter((p) => p.status === 'failed').length} failed
        </p>
        {payments.length ? (
          <div className="table-wrap">
            <table className="table adm-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Person</th>
                  <th scope="col">Plan</th>
                  <th scope="col" className="num">Paid</th>
                  <th scope="col">Coupon</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDateTime(p.paidAt || p.createdAt)}</td>
                    <td>{p.user.name || p.user.email || `Account ${p.user.id}`}</td>
                    <td>
                      {p.plan === 'trial' ? 'Free trial' : p.plan} · {p.days} days
                    </td>
                    <td className="num">
                      {p.amount ? rupees(p.amount) : 'Free'}
                      {p.listAmount && p.listAmount !== p.amount ? <small> (of {rupees(p.listAmount)})</small> : null}
                    </td>
                    <td>{p.coupon || '—'}</td>
                    <td>
                      <span className={`adm-tag${p.status === 'paid' ? ' is-pro' : p.status === 'failed' ? ' is-bad' : ''}`}>{p.status}</span>
                      {p.mode !== 'live' ? <small> {p.mode}</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-empty">No payments yet.</p>
        )}
      </section>
    </div>
  );
}
