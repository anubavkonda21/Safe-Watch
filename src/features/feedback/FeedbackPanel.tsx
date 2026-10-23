import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { MAX_REPORT_NOTE, MAX_REPORT_PHRASE, REPORT_CATEGORIES, REPORT_CATEGORY_LABEL, formatTimestamp, type ReportRejection } from '@/domain/feedback/report';
import { feedbackStore, useReports } from './feedbackStore';

const REJECTION_COPY: Record<ReportRejection, string> = {
  'empty-phrase': 'Enter the word or phrase that was missed.',
  'phrase-too-long': `Keep the phrase under ${MAX_REPORT_PHRASE} characters.`,
  'no-words': 'Include at least one letter or number.',
  'note-too-long': `Keep the note under ${MAX_REPORT_NOTE} characters.`,
  'invalid-timestamp': 'Enter a time such as 1:23 or 83.5.',
  'outside-media': 'That time is after the end of the video.',
  'invalid-category': 'Choose where you noticed it.',
  'limit-reached': 'You have saved the maximum number of reports. Delete some to add more.',
};
const FIELD_OF: Record<ReportRejection, 'timestamp' | 'phrase' | 'note' | 'category'> = {
  'empty-phrase': 'phrase', 'phrase-too-long': 'phrase', 'no-words': 'phrase', 'note-too-long': 'note', 'invalid-timestamp': 'timestamp', 'outside-media': 'timestamp', 'invalid-category': 'category', 'limit-reached': 'phrase',
};
const CATEGORY_OPTIONS = REPORT_CATEGORIES.map((c) => ({ value: c, label: REPORT_CATEGORY_LABEL[c] }));

interface Props {
  /** A random id for this viewing of this video (see MissedReport.session). */
  session: string;
  durationMs: number | null;
  /** The player's current position in milliseconds, or null when there is no player. */
  playheadMs: () => number | null;
}

/**
 * "Report a missed phrase": a note the user keeps, on this device, about a word or phrase SafeWatch did not flag. It is NOT a
 * finding and does not change the analysis; nothing is uploaded and nothing is trained. The list of saved reports can be
 * reviewed and deleted here.
 */
export function FeedbackPanel({ session, durationMs, playheadMs }: Props) {
  const reports = useReports();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [form, setForm] = useState({ timestamp: '', phrase: '', category: 'heard', note: '' });
  const [error, setError] = useState<{ field: 'timestamp' | 'phrase' | 'note' | 'category'; text: string } | null>(null);
  const uid = useId();

  function openForm() {
    const at = playheadMs();
    setForm({ timestamp: at === null ? '' : formatTimestamp(Math.min(at, durationMs ?? at)), phrase: '', category: 'heard', note: '' });
    setError(null); setSaved(false); setOpen(true);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const result = feedbackStore.add(form, { session, durationMs });
    if (!result.ok) { setError({ field: FIELD_OF[result.reason], text: REJECTION_COPY[result.reason] }); return; }
    setOpen(false); setSaved(true); setConfirmAll(false);
  }
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => { setForm((f) => ({ ...f, [field]: e.target.value })); if (error?.field === field) setError(null); };
  const err = (field: 'timestamp' | 'phrase' | 'note' | 'category') => (error?.field === field ? error.text : undefined);

  return (
    <section className="sw-feedback" aria-label="Missed phrases">
      <div className="sw-feedback__head">
        <p className="sw-label sw-muted">Missed a phrase?</p>
        <Button variant="secondary" onClick={openForm}>Report a missed phrase</Button>
      </div>
      <p className="sw-caption sw-muted">Saved only on this device, for you to review. It does not train SafeWatch, change this analysis or add a finding.</p>
      {saved && <p className="sw-body-sm sw-feedback__saved" role="status">Saved on this device. It is a note for you: it is not a finding and does not change the analysis.</p>}

      {reports.length > 0 && (
        <div className="sw-feedback__list">
          <ul aria-label="Your saved reports">
            {reports.map((r) => (
              <li key={r.id} className="sw-report">
                <div className="sw-report__text">
                  <span className="sw-caption sw-report__time">{formatTimestamp(r.timestampMs)}</span>
                  <span className="sw-body-sm sw-report__phrase">“{r.phrase}”</span>
                  <span className="sw-caption sw-muted">{REPORT_CATEGORY_LABEL[r.category]} · {r.session === session ? 'this video' : 'an earlier video'}{r.note ? ` · ${r.note}` : ''}</span>
                </div>
                <button type="button" className="sw-linkbtn sw-caption" aria-label={`Delete the report “${r.phrase}” at ${formatTimestamp(r.timestampMs)}`} onClick={() => feedbackStore.remove(r.id)}>Delete</button>
              </li>
            ))}
          </ul>
          {confirmAll ? (
            <div className="sw-feedback__confirm">
              <span className="sw-caption">Delete all {reports.length} saved reports?</span>
              <Button onClick={() => { feedbackStore.clear(); setConfirmAll(false); setSaved(false); }}>Yes, delete all</Button>
              <Button variant="secondary" onClick={() => setConfirmAll(false)}>Keep them</Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmAll(true)}>Delete all reports</Button>
          )}
        </div>
      )}

      <Modal open={open} title="Report a missed phrase" onClose={() => setOpen(false)}>
        <form className="sw-feedback__form" onSubmit={submit} noValidate aria-describedby={`${uid}-note`}>
          <p id={`${uid}-note`} className="sw-body-sm sw-muted">
            Tell us about a word or phrase that was in the video but was not flagged. The report is saved on this device only, so you can review it later. It does not train SafeWatch, is not sent anywhere, does not change this analysis and is not added to the findings.
          </p>
          <Input label="Time in the video" value={form.timestamp} inputMode="decimal" autoComplete="off" hint={durationMs ? `Between 0:00 and ${formatTimestamp(durationMs)}. Example: 1:23 or 83.5` : 'Example: 1:23 or 83.5'} error={err('timestamp')} onChange={set('timestamp')} />
          <Input label="Missed word or phrase" value={form.phrase} maxLength={MAX_REPORT_PHRASE + 20} autoComplete="off" spellCheck={false} error={err('phrase')} onChange={set('phrase')} />
          <Select label="Where did you notice it?" value={form.category} options={CATEGORY_OPTIONS} onChange={set('category')} />
          <Input label="Note (optional)" value={form.note} maxLength={MAX_REPORT_NOTE + 20} autoComplete="off" error={err('note')} onChange={set('note')} />
          <div className="sw-feedback__actions">
            <Button type="submit">Save report</Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
