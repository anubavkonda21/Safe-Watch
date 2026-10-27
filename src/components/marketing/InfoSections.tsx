import { Container } from '@/components/ui/Container';

/**
 * Where your video, your words and your settings go. This text is checked by tests against the rest of the page (nothing here may
 * contradict what the interface does) and must be updated whenever data handling changes.
 */
export function SafetySection() {
  return (
    <section id="safety" className="sw-section" aria-labelledby="safety-title">
      <Container className="sw-prose-grid">
        <h2 id="safety-title" className="sw-h1">Privacy and limits</h2>
        <div className="sw-prose">
          <p className="sw-body-lg sw-muted">
            <strong>A video file you choose</strong> is uploaded to your SafeWatch server, which by default runs on this computer. It is checked there with local tools (speech recognition when it is set up, and on macOS a frame-labelling tool), kept for a limited time (60 minutes by default) and then deleted. No outside service is used for it.
          </p>
          <p className="sw-body-lg sw-muted">
            <strong>A YouTube link</strong> plays in YouTube’s own player. Loading it contacts YouTube, which receives normal player information such as your IP address and browser details, under YouTube’s own terms. SafeWatch cannot see or hear a YouTube video and cannot read its captions. Only a caption file you add yourself is checked, in your browser; it is not sent anywhere.
          </p>
          <p className="sw-body-lg sw-muted">
            <strong>Your words, settings and reports</strong> are saved in this browser. For a file you upload, the words you enabled are sent to your SafeWatch server so it can match them; it does not store or log them. They are never sent to YouTube.
          </p>
          <p className="sw-body-lg sw-muted">
            <strong>What it can and cannot do.</strong> SafeWatch finds the words and phrases you list. It does not detect sexual content, violence, graphic injury or drug-related content, it gives no score, and a video with no findings is not thereby safe.
          </p>
        </div>
      </Container>
    </section>
  );
}

export function AboutSection() {
  return (
    <section id="about" className="sw-section" aria-labelledby="about-title">
      <Container className="sw-prose-grid">
        <h2 id="about-title" className="sw-h1">About SafeWatch</h2>
        <div className="sw-prose">
          <p className="sw-body-lg sw-muted">
            SafeWatch is an early-stage project. Today it checks your own words and phrases in a video’s speech and subtitles (or in a caption file you add for a YouTube video), warns you ahead of a match, and can mute or skip it if you choose. Recognising what is happening in a scene is not built.
          </p>
        </div>
      </Container>
    </section>
  );
}
