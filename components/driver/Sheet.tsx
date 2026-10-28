"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/lib/useFocusTrap";

const noop = () => () => {};
const phone = () => document.querySelector<HTMLElement>(".phone");

// Bottom sheet over the whole phone frame (prototype .modal / .sheet). Rendered into
// the .phone element so it covers the tab bar and inherits the language direction.
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const host = useSyncExternalStore(noop, phone, () => null);
  const trap = useFocusTrap(onClose);
  if (!host) return null;
  return createPortal(
    <div ref={trap} className="d-modal" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="d-sheet">{children}</div>
    </div>,
    host,
  );
}
