"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((m: string) => {
    setMessage(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 3500);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const node = message ? (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  ) : null;

  return { show, node };
}
