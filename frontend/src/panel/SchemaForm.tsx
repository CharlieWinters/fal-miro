import { useState } from 'react';
import { splitFields, type Field } from '../shared/schema';

type Values = Record<string, unknown>;

type Props = {
  fields: Field[];
  /** Always-shown field names, in order (e.g. COMMON_ARGS[capability]). */
  commonOrder: string[];
  values: Values;
  onChange: (name: string, value: unknown) => void;
  /** Field names to omit (e.g. an image field handled by a dedicated picker). */
  hide?: string[];
};

/**
 * Renders a model's input schema. Common fields show up-front; everything else
 * collapses under "Advanced". Controls are chosen from each field's kind, and
 * per-model enums / ranges come straight from the schema.
 */
export function SchemaForm({ fields, commonOrder, values, onChange, hide = [] }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const visible = hide.length ? fields.filter((f) => !hide.includes(f.name)) : fields;
  const { common, advanced } = splitFields(visible, commonOrder);

  return (
    <div className="schema-form">
      {common.map((f) => (
        <FieldControl key={f.name} field={f} value={values[f.name]} onChange={onChange} />
      ))}

      {advanced.length > 0 && (
        <div className="advanced">
          <button
            type="button"
            className="advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? '▾' : '▸'} Advanced ({advanced.length})
          </button>
          {advancedOpen &&
            advanced.map((f) => (
              <FieldControl key={f.name} field={f} value={values[f.name]} onChange={onChange} />
            ))}
        </div>
      )}
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}) {
  const label = (
    <span>
      {field.label}
      {field.required && <span className="req"> *</span>}
    </span>
  );
  const hint = field.description ? <span className="hint">{field.description}</span> : null;

  switch (field.kind) {
    case 'text':
    case 'json':
      return (
        <label className="field">
          {label}
          <textarea
            rows={field.kind === 'json' ? 3 : 4}
            value={asString(value)}
            placeholder={field.kind === 'json' ? '{ … } JSON' : ''}
            onChange={(e) => onChange(field.name, e.target.value)}
          />
          {hint}
        </label>
      );

    case 'image':
      return (
        <label className="field">
          {label}
          <input
            type="text"
            value={asString(value)}
            placeholder="Image URL (or connect an image on the board)"
            onChange={(e) => onChange(field.name, e.target.value)}
          />
          {hint}
        </label>
      );

    case 'boolean':
      return (
        <label className="field-row">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.name, e.target.checked)}
          />
          {label}
          {hint}
        </label>
      );

    case 'integer':
    case 'number':
      return (
        <label className="field">
          {label}
          <input
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            min={field.min}
            max={field.max}
            step={field.kind === 'integer' ? 1 : 'any'}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') return onChange(field.name, undefined);
              const n = field.kind === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
              onChange(field.name, Number.isNaN(n) ? undefined : n);
            }}
          />
          {hint}
        </label>
      );

    case 'enum':
      return (
        <label className="field">
          {label}
          <select value={asString(value)} onChange={(e) => onChange(field.name, e.target.value)}>
            {!field.required && <option value="">— default —</option>}
            {(field.enumValues ?? []).map((v) => (
              <option key={String(v)} value={String(v)}>
                {String(v)}
              </option>
            ))}
          </select>
          {hint}
        </label>
      );

    case 'string':
    default:
      return (
        <label className="field">
          {label}
          <input
            type="text"
            value={asString(value)}
            onChange={(e) => onChange(field.name, e.target.value)}
          />
          {hint}
        </label>
      );
  }
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}
