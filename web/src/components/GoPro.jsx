import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { track } from '../track.js';

// Everything that points free accounts to ArchJobs Pro (Settings > Plan): the header button, the
// strip on the Jobs page and the link next to a "weekly limit reached" message.

export const PLAN_HREF = '#/settings?tab=plan';
const DISMISS_KEY = 'aj-gopro-dismissed';
const DISMISS_MS = 7 * 86_400_000;

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Shown once Pro is on sale, to anyone not on it; a Pro badge for those who are. No sparkles or
// "AI" badges: Pro is sold on what it does for an application, in plain words.
export function GoProButton({ me }) {
  if (!me?.plans) return null;
  if (me.pro) {
    return (
      <a className="pro-badge" href={PLAN_HREF} title="ArchJobs Pro: your plan">
        Pro
      </a>
    );
  }
  return (
    <a className="go-pro-btn" href={PLAN_HREF} onClick={() => track('gopro:header')}>
      Go Pro
    </a>
  );
}

export function GoProLink() {
  return (
    <a className="btn btn-primary btn-sm go-pro-link" href={PLAN_HREF} onClick={() => track('gopro:limit')}>
      See Pro and the free trial
    </a>
  );
}

function dismissedRecently() {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DISMISS_MS;
  } catch {
    return false;
  }
}

// The strip at the top of the Jobs page for free accounts: what is left this week, and Go Pro.
// Closing it hides it for a week.
export function GoProBanner({ me }) {
  const [billing, setBilling] = useState(null);
  const [hidden, setHidden] = useState(dismissedRecently);
  const wanted = Boolean(me?.plans && !me.pro && !hidden);

  useEffect(() => {
    if (!wanted) return undefined;
    let alive = true;
    api('/billing')
      .then((d) => alive && setBilling(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [wanted]);

  if (!wanted || !billing?.enabled || billing.active || !billing.plans.length) return null;

  function close() {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // shows again next visit in private mode
    }
  }

  const cheapest = Math.min(...billing.plans.map((p) => p.amount));
  const { features, limited } = billing.quota;
  const left = (f) => Math.max(features[f].limit - features[f].used, 0);
  const trial = billing.trial?.available ? billing.trial.days : 0;
  // Says what is left, then answers the one question that stops people: is it worth paying for?
  return (
    <aside className="go-pro-banner" aria-label="ArchJobs Pro">
      <p className="gp-short">
        {limited ? (
          <>
            <strong>{left('tailor')} CVs</strong> and <strong>{left('analysis')} fit checks</strong> left this week.
          </>
        ) : (
          'No weekly limits with Pro.'
        )}
      </p>
      <p className="gp-long">
        {limited ? (
          <>
            This week you have <strong>{left('tailor')} tailored CV{left('tailor') === 1 ? '' : 's'}</strong> and <strong>{left('analysis')} job fit check{left('analysis') === 1 ? '' : 's'}</strong> left
            on the free plan.{' '}
          </>
        ) : null}
        {trial
          ? `Applying to a lot of firms? Try Pro free for ${trial} days: no weekly limits, no card needed, and it simply ends.`
          : `Applying to a lot of firms? Pro has no weekly limits, from ${rupees(cheapest)} a month, with a 7-day refund.`}
      </p>
      <a className="btn btn-primary btn-sm" href={PLAN_HREF} onClick={() => track('gopro:banner')}>
        {trial ? 'Try Pro free' : 'See Pro'}
      </a>
      <button type="button" className="icon-btn go-pro-close" onClick={close} aria-label="Hide for a week" title="Hide for a week">
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  );
}
