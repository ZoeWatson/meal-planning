/**
 * A labelled stepper for "how many of these do I want".
 *
 * Shared by the grab bags and the treat bag. They are separate features
 * with separate settings, but the control is the same gesture and the same
 * rules — never below zero, never above a ceiling, and a ceiling at all because
 * a stepper with no top invites a typo nobody notices until the shopping list is
 * absurd.
 */

/** A row of a labelled value with − / + either side of it. */
export function SizeRow({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div className="row between" style={{ marginTop: 10 }}>
      <span className="grow strong">{label}</span>
      <div className="stepper">
        <button
          aria-label={`Fewer ${label.toLowerCase()}`}
          disabled={disabled || value <= 0}
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          −
        </button>
        <span className="val">{value}</span>
        <button
          aria-label={`More ${label.toLowerCase()}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}
