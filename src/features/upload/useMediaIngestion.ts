import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MediaIngestion } from '@/application/mediaIngestion';
import { initialIngestionState, ingestionReducer } from '@/domain/media/ingestion';

/**
 * Drives the ingestion state machine: validating → accepted → processing → ready,
 * or failed. Results from a superseded or unmounted run are discarded.
 */
export function useMediaIngestion(ingestion: MediaIngestion) {
  const [state, dispatch] = useReducer(ingestionReducer, initialIngestionState);
  const run = useRef(0);

  useEffect(() => () => { run.current += 1; }, []);

  const select = useCallback(
    async (file: File) => {
      const id = ++run.current;
      const live = () => run.current === id;
      dispatch({ type: 'select', fileName: file.name });
      try {
        const accepted = await ingestion.accept(file);
        if (!live()) return;
        dispatch({ type: 'accepted', asset: accepted });
        dispatch({ type: 'process' });
        const ready = await ingestion.prepare(file, accepted);
        if (!live()) return;
        dispatch({ type: 'ready', asset: ready });
      } catch (error) {
        if (live()) dispatch({ type: 'fail', error });
      }
    },
    [ingestion],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, select, reset };
}
