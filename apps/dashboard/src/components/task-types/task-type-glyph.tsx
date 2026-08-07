interface TaskTypeGlyphProps {
  readonly type: string;
  readonly kind?: string;
}

/** Small, consistent line icons for task categories. */
export function TaskTypeGlyph({ type, kind = "" }: TaskTypeGlyphProps) {
  const normalized = `${type} ${kind}`.toLowerCase();

  if (normalized.includes("review")) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.5 3.5h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H10l-3.5 3v-3h-1a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
        <path d="m7 8.5 2 2 4-4" />
      </svg>
    );
  }

  if (/context|release|snapshot/.test(normalized)) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="5" cy="5" r="2" />
        <circle cx="15" cy="5" r="2" />
        <circle cx="10" cy="15" r="2" />
        <path d="m6.8 6.1 2.1 6.8m4.3-6.8-2.1 6.8M7 5h6" />
      </svg>
    );
  }

  if (/issue|investig|triage/.test(normalized)) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="4.5" />
        <path d="m12 12 4 4M8.5 6.5v2.7m0 2.1v.2" />
      </svg>
    );
  }

  if (/aggregate|coordinat|parent/.test(normalized)) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="3" width="5" height="5" rx="1" />
        <rect x="12" y="12" width="5" height="5" rx="1" />
        <path d="M8 5.5h3.5a2 2 0 0 1 2 2V12" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 5.5h12M4 10h12M4 14.5h8" />
      <path d="m13.5 13 2.5 2.5-2.5 2.5" />
    </svg>
  );
}
