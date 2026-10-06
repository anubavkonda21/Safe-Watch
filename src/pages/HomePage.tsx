import { Footer } from '@/components/layout/Footer';
import { Navigation } from '@/components/layout/Navigation';
import { FeaturePreview } from '@/components/marketing/FeaturePreview';
import { Hero } from '@/components/marketing/Hero';
import { HowItWorks } from '@/components/marketing/HowItWorks';
import { AboutSection, SafetySection } from '@/components/marketing/InfoSections';
import { UploadSection } from '@/components/marketing/UploadSection';
import { CustomFiltersSection } from '@/features/filters/CustomFilters';

export function HomePage() {
  return (
    <div id="top">
      <a className="sw-skip-link" href="#main">Skip to content</a>
      <Navigation />
      <main id="main" tabIndex={-1}>
        <Hero />
        <FeaturePreview />
        <UploadSection />
        <CustomFiltersSection />
        <HowItWorks />
        <SafetySection />
        <AboutSection />
      </main>
      <Footer />
    </div>
  );
}
