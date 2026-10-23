import { render, screen } from '@testing-library/react';
import { readyContext } from '@/test/contextAnalysis';
import { unavailableContext } from '@/domain/context/contextAnalysis';
import { unavailableVisual } from '@/domain/vision/visualAnalysis';
import { EvidenceAvailability } from './EvidenceAvailability';
import { ProductGuide } from './ProductGuide';

describe('ProductGuide', () => {
  it('lists the real steps and the supported formats from the validation rules', () => {
    render(<ProductGuide />);
    const guide = screen.getByRole('complementary', { name: 'What SafeWatch does today' });
    expect(guide).toHaveTextContent('Choose a video.');
    expect(guide).toHaveTextContent(/Formats: MP4/);
    expect(guide).toHaveTextContent('Add words or phrases');
    expect(guide).toHaveTextContent('Review the findings');
    expect(guide).toHaveTextContent('Watch with a heads-up.');
    expect(guide).toHaveTextContent('Choose Skip or Ignore when a warning appears');
  });
  it('states the one supported check and the four unsupported categories, taken from the taxonomy', () => {
    render(<ProductGuide />);
    expect(screen.getByText('Supported').closest('p')).toHaveTextContent('Your own words and phrases, in speech and subtitles.');
    expect(screen.getByText('Not supported yet').closest('p')).toHaveTextContent('sexual content, violence, graphic injury or gore, drug-related content. SafeWatch does not detect these.');
  });
  it('says that finding nothing is not proof, that frame descriptions are evidence only, and that reports train nothing', () => {
    render(<ProductGuide />);
    const text = screen.getByRole('complementary').textContent!;
    expect(text).toContain('Finding nothing does not mean a video is safe');
    expect(text).toContain('Frame descriptions are evidence only, not a safety judgement');
    expect(text).toContain('do not train SafeWatch');
  });
  it('makes no overall claim: no safe label, no protection claim, no score', () => {
    render(<ProductGuide />);
    expect(screen.getByRole('complementary').textContent).not.toMatch(/100%|protected|\bclean\b|score|guarantee|AI-powered detection of/i);
  });
});

describe('EvidenceAvailability', () => {
  it('shows what exists for this video in the system’s own words', () => {
    render(<EvidenceAvailability context={readyContext('m')} />);
    const dl = screen.getByLabelText('Evidence available for this video');
    expect(dl).toHaveTextContent('Speechavailable');
    expect(dl).toHaveTextContent('Subtitlesavailable');
    expect(dl).toHaveTextContent('Visual evidenceavailable');
  });
  it('distinguishes none found, could not be read, not enabled and still checking', () => {
    const base = readyContext('m');
    const { rerender } = render(<EvidenceAvailability context={{ ...base, inputs: { speech: 'empty', subtitles: 'failed', visual: 'not-enabled' } }} />);
    const dl = () => screen.getByLabelText('Evidence available for this video');
    expect(dl()).toHaveTextContent('Speechnone found');
    expect(dl()).toHaveTextContent('Subtitlescould not be read');
    expect(dl()).toHaveTextContent('Visual evidencenot enabled on this server');
    rerender(<EvidenceAvailability context={null} />);
    expect(dl()).toHaveTextContent('Speechchecking…');
  });
  it('reflects a missing modality from a real context', () => {
    render(<EvidenceAvailability context={readyContext('m', { visual: unavailableVisual('m', 'x', 'provider-unavailable') })} />);
    expect(screen.getByLabelText('Evidence available for this video')).toHaveTextContent('Visual evidencenot enabled on this server');
  });
  it('an unavailable context shows every input as could not be read, never as available', () => {
    render(<EvidenceAvailability context={unavailableContext('m')} />);
    expect(screen.getByLabelText('Evidence available for this video').textContent).not.toMatch(/available/);
  });
  it('says nothing about safety', () => {
    render(<EvidenceAvailability context={readyContext('m')} />);
    expect(screen.getByLabelText('Evidence available for this video').textContent).not.toMatch(/safe|clean|risk|score/i);
  });
});
