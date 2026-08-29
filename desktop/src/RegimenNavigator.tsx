export function RegimenNavigator({ regimens, selectedId, onSelect, compact = false, label = "Regimen" }: {
  regimens: Array<{ id: string; label: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  compact?: boolean;
  label?: string;
}) {
  if (regimens.length === 0) return null;
  const index = Math.max(0, regimens.findIndex((regimen) => regimen.id === selectedId));
  const choose = (next: number) => onSelect(regimens[(next + regimens.length) % regimens.length].id);
  return <div className={`regimen-navigator${compact ? " compact" : ""}`}>
    <button type="button" aria-label={`Previous ${label.toLowerCase()}`} onClick={() => choose(index - 1)}>‹</button>
    <select aria-label={label} value={selectedId} onChange={(event) => onSelect(event.target.value)}>
      {regimens.map((regimen) => <option key={regimen.id} value={regimen.id}>{regimen.label}</option>)}
    </select>
    <button type="button" aria-label={`Next ${label.toLowerCase()}`} onClick={() => choose(index + 1)}>›</button>
  </div>;
}
