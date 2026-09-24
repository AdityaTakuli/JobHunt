import { useCallback, useMemo } from 'react';
import { api } from './api.js';
import { useMeta } from './App.jsx';
import { useToast } from './components/Toast.jsx';

// Save / apply / hide actions shared by the job list and the detail panel.
// onChange(jobId, patch) lets the caller update its local copy of the job.
export function useJobActions(onChange) {
  const { toast } = useToast();
  const { refreshMeta } = useMeta();

  const fail = useCallback((err) => toast({ message: err.message, error: true, duration: 6000 }), [toast]);

  const setStatus = useCallback(
    async (job, status) => {
      try {
        const { application } = await api('/applications', { method: 'POST', body: { job_id: job.id, status } });
        onChange(job.id, { application_id: application.id, application_status: application.status });
        refreshMeta();
        return application;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [onChange, refreshMeta, fail],
  );

  const toggleSave = useCallback(
    async (job) => {
      if (job.application_status === 'saved') {
        try {
          await api(`/applications/${job.application_id}`, { method: 'DELETE' });
          onChange(job.id, { application_id: null, application_status: null });
        } catch (err) {
          fail(err);
        }
        return;
      }
      if (job.application_status) {
        window.location.hash = '#/tracker';
        return;
      }
      if (await setStatus(job, 'saved')) toast({ message: 'Saved to your tracker.' });
    },
    [onChange, setStatus, toast, fail],
  );

  // Called from the Apply link's click; the link itself opens the posting in a new tab.
  const promptApplied = useCallback(
    (job) => {
      if (['applied', 'interview', 'offer', 'rejected'].includes(job.application_status)) return;
      toast({
        id: `apply-${job.id}`,
        duration: 0,
        message: `Applied to ${job.title}${job.company ? ` at ${job.company}` : ''}?`,
        actions: [
          { label: 'Not yet' },
          {
            label: 'Mark as applied',
            primary: true,
            onClick: async () => {
              if (await setStatus(job, 'applied')) toast({ message: 'Marked as applied. Follow-up set for 7 days.' });
            },
          },
        ],
      });
    },
    [setStatus, toast],
  );

  const hide = useCallback(
    async (job, reason = 'Not relevant', onUndo) => {
      try {
        await api(`/jobs/${job.id}/hide`, { method: 'POST', body: { reason } });
        onChange(job.id, { hidden: true });
        refreshMeta();
        toast({
          message: 'Job hidden.',
          duration: 6000,
          actions: [
            {
              label: 'Undo',
              onClick: async () => {
                try {
                  await api(`/jobs/${job.id}/unhide`, { method: 'POST' });
                  onUndo?.();
                  refreshMeta();
                } catch (err) {
                  fail(err);
                }
              },
            },
          ],
        });
      } catch (err) {
        fail(err);
      }
    },
    [onChange, refreshMeta, toast, fail],
  );

  return useMemo(() => ({ toggleSave, promptApplied, setStatus, hide }), [toggleSave, promptApplied, setStatus, hide]);
}
