import type { IntentState } from '../lib/input-state';
import { intentSummary } from '../lib/input-summary';

export function IntentSummary({ state, onEdit, onReset, disabled }: {
  state: IntentState;
  onEdit: () => void;
  onReset: () => void;
  disabled: boolean;
}) {
  const { required, preferred } = intentSummary(state, (value) =>
    new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(value),
  );
  if (!required.length && !preferred.length) return null;
  return (
    <aside className="intent-summary" aria-label="Anlaşılan plan">
      <div className="intent-summary-heading">
        <strong>Planını böyle anladık</strong>
        <div>
          <button type="button" disabled={disabled} onClick={onEdit}>Planı düzelt</button>
          <button type="button" disabled={disabled} onClick={onReset}>Planı temizle</button>
        </div>
      </div>
      {required.length > 0 && (
        <fieldset className="intent-summary-row">
          <legend className="intent-summary-label">Olmazsa olmazlar</legend>
          <ul>{required.map((item) => <li key={item}>{item}</li>)}</ul>
        </fieldset>
      )}
      {preferred.length > 0 && (
        <fieldset className="intent-summary-row">
          <legend className="intent-summary-label">Tercihler</legend>
          <ul>{preferred.map((item) => <li key={item}>{item}</li>)}</ul>
        </fieldset>
      )}
      <p>Tercihler sıralamaya yardımcı olur. Tüm koşullarını tek mesajda yaz.</p>
    </aside>
  );
}
