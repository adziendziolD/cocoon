import { useEffect, useState } from 'react';

/**
 * Local editable copy of server data. Follows server updates until the user starts editing;
 * `dirty` tells whether there are unsaved changes.
 */
export function useDraft<T>(source: T | undefined) {
  const [baseline, setBaseline] = useState<T | undefined>(source);
  const [draft, setDraft] = useState<T | undefined>(source);
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(baseline);

  useEffect(() => {
    if (source !== undefined && !dirty) {
      setBaseline(source);
      setDraft(source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(source)]);

  const reset = (next: T | undefined = source) => {
    setBaseline(next);
    setDraft(next);
  };

  return { draft, setDraft, dirty, reset };
}
