import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MediaIngestion } from '@/application/mediaIngestion';
import { initialIngestionState, ingestionReducer } from '@/domain/media/ingestion';

/**
 * Drives the ingestion state machine: validating → accepted → processing → ready,
 * or failed. Results from a superseded or unmounted run are discarded, and the
 * previous server-side upload is released when the user replaces it.
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
        dispatch({ type: 'ready', asset: prepared.asset, analysis: prepared.analysis });
      } catch (error) {
        if (live()) dispatch({ type: 'fail', error });
      }
    },
    [ingestion],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, select, reset };
}
