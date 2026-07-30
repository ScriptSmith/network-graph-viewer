import type { GraphStyle } from "../types";
import { CUSTOM, PALETTES, RAMPS, resolvePalette, type ColorSet } from "../theme";

interface PalettePickerProps {
  style: GraphStyle;
  onStyleChange: (patch: Partial<GraphStyle>) => void;
}

/** Room for as many groups as anyone can tell apart, and at least two. */
const MAX_SLOTS = 16;
const MIN_SLOTS = 2;

interface SwatchesProps {
  colors: string[];
  /** Absent while a shipped set is selected, which is shown but not edited. */
  onChange?: (colors: string[]) => void;
  label: string;
}

/**
 * A color set as a row of swatches. Each is a native color input, so the
 * platform's own picker does the work and the value that comes back is always
 * the six-digit hex the rest of the app expects.
 */
function Swatches({ colors, onChange, label }: SwatchesProps) {
  if (!onChange) {
    return (
      <div className="swatches" aria-label={label}>
        {colors.map((c, i) => (
          <span key={`${c}${i}`} className="swatch swatch-fixed" style={{ background: c }} />
        ))}
      </div>
    );
  }
  const replace = (index: number, value: string) =>
    onChange(colors.map((c, i) => (i === index ? value : c)));
  return (
    <div className="swatches" aria-label={label}>
      {colors.map((c, i) => (
        <span key={i} className="swatch-slot">
          <input
            type="color"
            className="swatch"
            value={c}
            aria-label={`${label} color ${i + 1}`}
            onChange={(e) => replace(i, e.target.value)}
          />
          {colors.length > MIN_SLOTS && (
            <button
              type="button"
              className="swatch-drop"
              onClick={() => onChange(colors.filter((_, j) => j !== i))}
              title="Remove this color"
              aria-label={`Remove ${label} color ${i + 1}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {colors.length < MAX_SLOTS && (
        <button
          type="button"
          className="swatch-add"
          onClick={() => onChange([...colors, colors[colors.length - 1]])}
          title="Add a color"
          aria-label={`Add a ${label} color`}
        >
          +
        </button>
      )}
    </div>
  );
}

function options(sets: ColorSet[]) {
  return sets.map((s) => (
    <option key={s.id} value={s.id}>
      {s.name}
    </option>
  ));
}

/**
 * The colors the graph is drawn in: which categorical set the groups come out
 * of, and which ramp a numeric ranking is stepped along. Picking "Custom"
 * starts from whatever was on screen rather than from nothing, so editing a
 * shipped set is a matter of nudging the slots that are wrong.
 *
 * Custom colors live in the style, which means they travel with a saved
 * workspace and with a shared link.
 */
export function PalettePicker({ style, onStyleChange }: PalettePickerProps) {
  const current = resolvePalette(style);
  const customPalette = style.palette === CUSTOM;
  const customRamp = style.ramp === CUSTOM;

  return (
    <>
      <label className="field">
        <span className="field-label">Group colors</span>
        <select
          className="control"
          value={style.palette}
          onChange={(e) => {
            const next = e.target.value;
            onStyleChange(
              next === CUSTOM
                ? { palette: next, customPalette: style.customPalette ?? current.categorical }
                : { palette: next },
            );
          }}
        >
          {options(PALETTES)}
          <option value={CUSTOM}>Custom</option>
        </select>
      </label>
      <Swatches
        label="Group"
        colors={current.categorical}
        onChange={customPalette ? (colors) => onStyleChange({ customPalette: colors }) : undefined}
      />

      <label className="field">
        <span className="field-label">Ranking ramp</span>
        <select
          className="control"
          value={style.ramp}
          onChange={(e) => {
            const next = e.target.value;
            onStyleChange(
              next === CUSTOM
                ? { ramp: next, customRamp: style.customRamp ?? current.sequential }
                : { ramp: next },
            );
          }}
        >
          {options(RAMPS)}
          <option value={CUSTOM}>Custom</option>
        </select>
      </label>
      {/* Stops read low to high, and are stepped rather than interpolated, so
          what the swatches show is what the nodes get. */}
      <Swatches
        label="Ramp"
        colors={current.sequential}
        onChange={customRamp ? (colors) => onStyleChange({ customRamp: colors }) : undefined}
      />
    </>
  );
}
