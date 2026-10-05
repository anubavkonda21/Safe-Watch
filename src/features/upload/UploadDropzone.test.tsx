import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MetadataReader } from '@/application/ingestMedia';
import { UploadDropzone } from './UploadDropzone';

const MB = 1024 * 1024;
const okReader: MetadataReader = { read: async () => ({ durationSeconds: 125, width: 1920, height: 1080 }) };

function video(name = 'clip.mp4', size = MB, type = 'video/mp4') {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}
const group = () => screen.getByRole('group');

describe('UploadDropzone', () => {
  it('starts in the default state', () => {
    render(<UploadDropzone reader={okReader} />);
    expect(screen.getByRole('heading', { name: 'Drop a video to analyze' })).toBeInTheDocument();
    expect(screen.getByText('MP4, MOV, MKV and other supported formats')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose video' })).toBeInTheDocument();
    expect(group()).toHaveAttribute('data-state', 'idle');
  });

  it('shows drag-over state and reverts on leave', () => {
    render(<UploadDropzone reader={okReader} />);
    fireEvent.dragOver(group());
    expect(group()).toHaveAttribute('data-state', 'dragging');
    fireEvent.dragLeave(group());
    expect(group()).toHaveAttribute('data-state', 'idle');
  });

  it('reads a chosen video, passes through processing and reaches success with a sanitised name', async () => {
    let release!: () => void;
    const slow: MetadataReader = { read: () => new Promise((res) => { release = () => res({ durationSeconds: 125, width: 1920, height: 1080 }); }) };
    render(<UploadDropzone reader={slow} />);
    await userEvent.upload(screen.getByLabelText('Video file'), video('../../my;clip.mp4', 3 * MB));
    expect(group()).toHaveAttribute('data-state', 'processing');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    release();
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'success'));
    expect(screen.getByText('my_clip.mp4')).toBeInTheDocument();
    expect(screen.getByText(/3\.0 MB · 2:05 · 1920×1080/)).toBeInTheDocument();
    expect(screen.getByText('Analysis is not available yet')).toBeInTheDocument();
  });

  it('accepts a dropped file', async () => {
    render(<UploadDropzone reader={okReader} />);
    fireEvent.drop(group(), { dataTransfer: { files: [video()] } });
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'success'));
  });

  it('rejects unsupported types, then allows retry', async () => {
    render(<UploadDropzone reader={okReader} />);
    fireEvent.drop(group(), { dataTransfer: { files: [video('notes.txt', 10, 'text/plain')] } });
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'error'));
    expect(screen.getByRole('alert')).toHaveTextContent('This file type is not supported');
    expect(screen.getByRole('button', { name: 'Choose another video' })).toBeInTheDocument();
  });

  it('rejects files over the size limit and states the limit', async () => {
    render(<UploadDropzone reader={okReader} maxBytes={MB} />);
    fireEvent.drop(group(), { dataTransfer: { files: [video('big.mp4', 2 * MB)] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('1.0 MB'));
  });

  it('reports unreadable files', async () => {
    const failing: MetadataReader = { read: async () => { throw new Error('bad'); } };
    render(<UploadDropzone reader={failing} />);
    fireEvent.drop(group(), { dataTransfer: { files: [video()] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not read'));
  });
});
