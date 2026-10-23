import { Button } from '@/components/ui/Button';
import { DURATION_OPTIONS_SECONDS, LEAD_OPTIONS_SECONDS } from '@/domain/preferences/preferences';
import { preferencesStore, usePreferences } from '@/features/preferences/preferencesStore';

/**
 * The few preferences SafeWatch can honour today. They are remembered in this browser only. The default action for undecided
 * findings lives next to the findings (it is the CP8 setting, shared, not duplicated here).
 */
export function PlaybackPreferences() {
  const prefs = usePreferences();
  return (
    <details className="sw-details sw-prefs">
      <summary className="sw-body-sm">Preferences</summary>
      <div className="sw-details__body">
        <label className="sw-pswitch">
          <input type="checkbox" role="switch" checked={prefs.warningsEnabled} onChange={(e) => preferencesStore.update({ warningsEnabled: e.target.checked })} />
          <span className="sw-body-sm">Warn me before a flagged phrase</span>
        </label>
        <div className="sw-prefs__row">
          <label className="sw-pselect">
            <span className="sw-caption sw-muted">Warn me this far ahead</span>
            <select className="sw-select" value={prefs.leadSeconds} disabled={!prefs.warningsEnabled} onChange={(e) => preferencesStore.update({ leadSeconds: Number(e.target.value) as typeof prefs.leadSeconds })}>
              {LEAD_OPTIONS_SECONDS.map((s) => <option key={s} value={s}>{s} seconds{s === 20 ? ' (recommended)' : ''}</option>)}
            </select>
          </label>
          <label className="sw-pselect">
            <span className="sw-caption sw-muted">Keep the warning visible for</span>
            <select className="sw-select" value={prefs.durationSeconds} disabled={!prefs.warningsEnabled} onChange={(e) => preferencesStore.update({ durationSeconds: Number(e.target.value) as typeof prefs.durationSeconds })}>
              {DURATION_OPTIONS_SECONDS.map((s) => <option key={s} value={s}>{s} seconds{s === 3 ? ' (recommended)' : ''}</option>)}
            </select>
          </label>
        </div>
        <p className="sw-caption sw-muted">
          A warning is only a heads-up: if you do nothing it goes away and playback continues unchanged. You can always dismiss it, and warnings pause while your pointer or keyboard focus is on them. Warnings need automatic actions to be on. These settings are saved in this browser only.
        </p>
        <Button variant="secondary" onClick={() => preferencesStore.reset()}>Restore defaults</Button>
      </div>
    </details>
  );
}
