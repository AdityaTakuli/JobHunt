import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { IconSparkle } from '../icons.jsx';

// Everything that points free accounts to ArchJobs Pro (Settings > Plan): the header button, the
// strip on the Jobs page and the link next to a "weekly limit reached" message.

export const PLAN_HREF = '#/settings?tab=plan';
const DISMISS_KEY = 'aj-gopro-dismissed';
const DISMISS_MS = 7 * 86_400_000;

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Shown once Pro is on sale, to anyone not on it; a Pro badge for those who are.
export function GoProButton({ me }) {
  if (!me?.plans) return null;
  if (me.pro) {
    return (
      <a className="pro-badge" href={PLAN_HREF} title="ArchJobs Pro: your plan">
        <IconSparkle size={14} />
        Pro
      </a>
    );
  }
  return (
    <a className="go-pro-btn" href={PLAN_HREF}>
      <IconSparkle size={15} />
      Go Pro
    </a>
  );
}

export function GoProLink() {
  return (
    <a className="btn btn-primary btn-sm go-pro-link" href={PLAN_HREF}>
      <IconSparkle size={15} />
      Go Pro for no weekly limit
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
  return (
    <aside className="go-pro-banner" aria-label="ArchJobs Pro">
      <IconSparkle size={18} className="go-pro-banner-icon" />
      <p>
        {limited ? (
          <>
            <strong>Free plan:</strong> {left('tailor')} of {features.tailor.limit} tailored CVs and {left('analysis')} of {features.analysis.limit} AI
            job analyses left this week. <strong>Pro</strong> has no weekly limits, from {rupees(cheapest)} a month.
          </>
        ) : (
          <>
            <strong>ArchJobs Pro:</strong> unlimited tailored CVs and cover letters, AI job analyses and ARCH answers, from {rupees(cheapest)} a month.
          </>
        )}
      </p>
      <a className="btn btn-primary btn-sm" href={PLAN_HREF}>
        Go Pro
      </a>
      <button type="button" className="icon-btn go-pro-close" onClick={close} aria-label="Hide for a week" title="Hide for a week">
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  );
}
