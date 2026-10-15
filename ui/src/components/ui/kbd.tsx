import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-border bg-surface-raised px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
