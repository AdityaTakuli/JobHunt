import { motion } from 'motion/react';
import { ROLE_LABELS } from '../format.js';
import { IconBookmark, IconBookmarkFilled, IconEyeOff } from '../icons.jsx';
import { ApplyBadge, CompanyAvatar, ExperienceBadge, Salary, shortAge } from './JobBits.jsx';

// A compact result in the list (Glassdoor-style): company, title, place, pay, experience and age.
// Cards rise in with a short stagger (`order` = position in the batch just loaded), slide out when
// hidden, and neighbours glide into the gap (layout). `ref` is forwarded so AnimatePresence can
// measure the card while it leaves.
export default function JobCard({ ref, job, order = 0, selected, onOpen, actions }) {
  const saved = Boolean(job.application_status);

  return (
    <motion.li
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.35, delay: Math.min(order, 8) * 0.045, ease: [0.22, 1, 0.36, 1] } }}
      exit={{ opacity: 0, x: -24, transition: { duration: 0.22, ease: 'easeIn' } }}
      className={`job-card${selected ? ' is-selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => {
        // Clicks on the card open details, but not clicks on its buttons and links.
        if (!e.target.closest('a, button')) onOpen(job);
      }}
    >
      <div className="jc-head">
        <CompanyAvatar name={job.company} size={36} />
        <span className="jc-company truncate">{job.company || 'Company not listed'}</span>
        <div className="jc-tools">
          <button
            type="button"
            className={`icon-btn icon-btn-sm${saved ? ' is-on' : ''}`}
            onClick={() => actions.toggleSave(job)}
            aria-pressed={saved}
            aria-label={saved ? `Saved: ${job.title}` : `Save ${job.title}`}
            title={saved ? 'Saved' : 'Save'}
          >
            {saved ? <IconBookmarkFilled size={17} /> : <IconBookmark size={17} />}
          </button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => actions.hide(job)} aria-label={`Hide ${job.title}`} title="Not relevant: hide">
            <IconEyeOff size={17} />
          </button>
        </div>
      </div>

      <h2 className="jc-title">
        <button type="button" onClick={() => onOpen(job)}>
          {job.title}
        </button>
      </h2>
      <p className="jc-place">{job.city || job.location_text || 'Location not listed'}</p>
      <p className="jc-pay">
        <Salary job={job} />
      </p>

      <div className="jc-foot">
        <div className="badges">
          <ExperienceBadge job={job} />
          <ApplyBadge job={job} />
          {job.role_type === 'internship' && <span className="badge">{ROLE_LABELS.internship}</span>}
          {job.is_bim && <span className="badge badge-accent">BIM</span>}
        </div>
        <span className="jc-age">{shortAge(job)}</span>
      </div>
    </motion.li>
  );
}
