"use client";

import { useEffect, useRef, useState } from "react";

// Keyboard focus containment for modal dialogs and sheets (P5): focus moves
// into the dialog when it opens, Tab / Shift+Tab loop inside it, Escape closes
// it (when an onEscape is given), and focus returns to the trigger on close.
// Only the top-most open dialog reacts, so nested dialogs work.

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

const stack: HTMLElement[] = [];

function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

/** Returns a ref callback for the dialog element. */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(onEscape?: () => void) {
  const [node, setNode] = useState<T | null>(null);
  // The element that had focus when the dialog was opened.
  const [trigger] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const escRef = useRef(onEscape);
  useEffect(() => {
    escRef.current = onEscape;
  });

  useEffect(() => {
    if (!node) return;
    stack.push(node);
    if (!node.contains(document.activeElement)) {
      const first = focusables(node)[0];
      if (first) first.focus();
      else {
        if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
        node.focus();
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== node) return;
      if (e.key === "Escape" && escRef.current) {
        e.preventDefault();
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusables(node);
      if (!els.length) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && node.contains(active);
      if (e.shiftKey && (!inside || active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus that escapes by other means (e.g. a click behind the backdrop) is pulled back.
    const onFocusIn = (e: FocusEvent) => {
      if (stack[stack.length - 1] !== node || node.contains(e.target as Node)) return;
      (focusables(node)[0] ?? node).focus();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      const i = stack.lastIndexOf(node);
      if (i >= 0) stack.splice(i, 1);
      if (trigger && trigger.isConnected && trigger !== document.body) trigger.focus();
    };
  }, [node, trigger]);

  return setNode;
}
