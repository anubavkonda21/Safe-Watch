import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MediaIngestion } from '@/application/mediaIngestion';
import { unavailableTextAnalysis, type TextAnalysisIssueCode } from '@/domain/text/textAnalysis';
import { unavailableVisual, type VisualIssue } from '@/domain/vision/visualAnalysis';
import { unavailableExtraction, type ExtractionErrorCode } from '@/domain/extraction/extraction';
import type { MediaAsset } from '@/domain/media/asset';
import { MediaIngestionError } from '@/domain/media/errors';
import { initialIngestionState, ingestionReducer } from '@/domain/media/ingestion';

function extractionCodeFor(error: unknown): ExtractionErrorCode {
  if (error instanceof MediaIngestionError) {
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'server-unreachable') return 'server-unreachable';
  }
  return 'extraction-failed';
}

function textCodeFor(error: unknown): TextAnalysisIssueCode {
  if (error instanceof MediaIngestionError) {
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'server-unreachable') return 'server-unreachable';
  }
  return 'provider-failed';
}

function visualCodeFor(error: unknown): VisualIssue['code'] {
  if (error instanceof MediaIngestionError) {
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'server-unreachable') return 'server-unreachable';
  }
  return 'inference-failed';
}

/**
 * Drives the ingestion state machine: validating → accepted → processing → ready,
 * or failed. After media is ready (server mode) it follows extraction as a
 * separate step. Results from a superseded or unmounted run are discarded, and
 * the previous server-side upload is released when the user replaces it.
 */
export function useMediaIngestion(ingestion: MediaIngestion) {
  const [state, dispatch] = useReducer(ingestionReducer, initialIngestionState);
  const run = useRef(0);
  const latest = useRef(state);

  useEffect(() => { latest.current = state; }, [state]);
  useEffect(() => () => { run.current += 1; }, []);

  const select = useCallback(
    async (file: File) => {
      const previous = latest.current;
      if (previous.status === 'ready') void ingestion.remove(previous.asset);

      const id = ++run.current;
      const live = () => run.current === id;
      dispatch({ type: 'select', fileName: file.name });
      let ready: MediaAsset;
      try {
        const accepted = await ingestion.accept(file);
        if (!live()) return;
        dispatch({ type: 'accepted', asset: accepted });
        dispatch({ type: 'process', phase: ingestion.mode === 'server' ? 'uploading' : 'inspecting' });
        const prepared = await ingestion.prepare(file, accepted, {
          onProgress: (fraction) => { if (live()) dispatch({ type: 'progress', fraction }); },
        });
        if (!live()) {
          void ingestion.remove(prepared.asset); // superseded while preparing: do not leave it on the server
          return;
        }
        ready = prepared.asset;
        dispatch({ type: 'ready', asset: ready, analysis: prepared.analysis });
      } catch (error) {
        if (live()) dispatch({ type: 'fail', error });
        return;
      }

      // Extraction is a separate step. Trouble here never turns a ready media item into a failed one.
      try {
        const final = await ingestion.extract(ready, {
          onUpdate: (extraction) => { if (live()) dispatch({ type: 'extraction', extraction }); },
        });
        // The returned manifest is authoritative even if the port never reported it through onUpdate.
        if (final && live()) dispatch({ type: 'extraction', extraction: final });
        if (!final || final.status !== 'completed') return; // text analysis only follows a completed extraction
      } catch (error) {
        if (live()) dispatch({ type: 'extraction', extraction: unavailableExtraction(ready.id, new Date().toISOString(), extractionCodeFor(error)) });
        return;
      }

      // Text and visual evidence are separate steps that run side by side on the server; each one's trouble stays its own.
      const text = (async () => {
        try {
          const result = await ingestion.analyzeText(ready, {
            onUpdate: (textAnalysis) => { if (live()) dispatch({ type: 'text-analysis', textAnalysis }); },
          });
          if (result && live()) dispatch({ type: 'text-analysis', textAnalysis: result });
        } catch (error) {
          if (live()) dispatch({ type: 'text-analysis', textAnalysis: unavailableTextAnalysis(ready.id, new Date().toISOString(), textCodeFor(error)) });
        }
      })();
      const visual = (async () => {
        try {
          const result = await ingestion.analyzeVisual(ready, {
            onUpdate: (v) => { if (live()) dispatch({ type: 'visual-analysis', visual: v }); },
          });
          // No visual support behind the port: say so instead of waiting forever.
          if (live()) dispatch({ type: 'visual-analysis', visual: result ?? unavailableVisual(ready.id, new Date().toISOString(), 'provider-unavailable') });
        } catch (error) {
          if (live()) dispatch({ type: 'visual-analysis', visual: unavailableVisual(ready.id, new Date().toISOString(), visualCodeFor(error)) });
        }
      })();
      await Promise.all([text, visual]);
    },
    [ingestion],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, select, reset };
}
