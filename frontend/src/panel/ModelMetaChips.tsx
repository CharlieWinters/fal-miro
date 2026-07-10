// Category + tag chips for a model, read from fal's per-endpoint metadata (the
// same `metadata` block the /api/fal/schema route returns). Renders nothing when
// there's no metadata, so it's safe to drop on any model screen.

export function ModelMetaChips({ metadata }: { metadata: Record<string, unknown> | null | undefined }) {
  if (!metadata) return null;
  const category = typeof metadata.category === 'string' ? metadata.category : null;
  const tags = Array.isArray(metadata.tags)
    ? (metadata.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  if (!category && tags.length === 0) return null;

  return (
    <div className="model-tags">
      {category && <span className="chip chip-cat">{category}</span>}
      {tags.slice(0, 6).map((t) => (
        <span key={t} className="chip">
          {t}
        </span>
      ))}
    </div>
  );
}
