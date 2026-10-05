/**
 * Decorative illustration of the intended product: a video frame, a timeline
 * with detected moments, and signal lanes. It is illustrative, not real data.
 */
const LANES = [
  { label: 'Speech', marks: [18, 42, 67], tone: 'info' },
  { label: 'Visual', marks: [30, 74], tone: 'warning' },
  { label: 'Context', marks: [52], tone: 'accent' },
] as const;

export function AnalysisVisual() {
  return (
    <figure className="sw-visual" aria-label="Illustration: a video timeline with moments flagged by analysis">
      <div className="sw-visual__frame" aria-hidden="true">
        <div className="sw-visual__scene" />
        <span className="sw-visual__scan" />
        <span className="sw-visual__play" />
      </div>
      <div className="sw-visual__lanes" aria-hidden="true">
        {LANES.map((lane) => (
          <div className="sw-visual__lane" key={lane.label}>
            <span className="sw-caption sw-visual__lane-label">{lane.label}</span>
            <div className="sw-visual__track">
              {lane.marks.map((m) => (
                <span key={m} className={`sw-visual__mark sw-visual__mark--${lane.tone}`} style={{ left: `${m}%` }} />
              ))}
            </div>
          </div>
        ))}
        <span className="sw-visual__playhead" />
      </div>
      <figcaption className="sw-caption sw-visual__caption">Illustrative preview</figcaption>
    </figure>
  );
}
