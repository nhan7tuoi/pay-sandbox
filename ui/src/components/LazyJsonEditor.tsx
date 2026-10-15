import { Loader2 } from "lucide-react";
import { Suspense, lazy } from "react";

const loadEditor = () => import("./JsonEditor");

/** CodeMirror lives in its own chunk and is fetched the first time an editor mounts. */
const JsonEditor = lazy(() => loadEditor().then((module) => ({ default: module.JsonEditor })));

/** Starts downloading the editor chunk early, e.g. when the user hovers "Edit & Fire". */
export function preloadJsonEditor(): void {
  void loadEditor();
}

interface LazyJsonEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function LazyJsonEditor({ value, onChange }: LazyJsonEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 px-5 py-4 text-xs text-subtle">
          <Loader2 className="size-3.5 animate-spin" />
          Loading editor…
        </div>
      }
    >
      <JsonEditor value={value} onChange={onChange} />
    </Suspense>
  );
}
