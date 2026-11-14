import { useState, type ReactNode } from "react";
import { roleLabel } from "./analysis";
import type { ColumnRole } from "./types";

const pageSize = 100;

export function ImportDataTable({ headers, rows, rowNumbers, roles, roleOptions, excludedRows, disabled, setExcluded, setRole, displayCell }: {
  headers: string[];
  rows: string[][];
  rowNumbers?: number[];
  roles: ColumnRole[];
  roleOptions: ColumnRole[];
  excludedRows: number[];
  disabled: boolean;
  setExcluded: (rowNumber: number, excluded: boolean) => void;
  setRole: (column: number, role: ColumnRole) => void;
  displayCell: (value?: string) => ReactNode;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  const first = page * pageSize;
  const excluded = new Set(excludedRows);
  const excludedCount = rowNumbers?.filter((number) => excluded.has(number)).length ?? 0;
  return <>
    <div className="import-row-controls">
      <p className="help-text">Check Exclude to omit a file row from further analysis. Uncheck it to include it again. {excludedCount} of {rows.length} displayed-set rows excluded.</p>
      {pageCount > 1 && <div className="import-row-pages" aria-label="Import table pages">
        <button type="button" className="secondary-button" disabled={page === 0} onClick={() => setRequestedPage(page - 1)}>Previous rows</button>
        <span>Rows {first + 1}–{Math.min(first + pageSize, rows.length)} of {rows.length}</span>
        <button type="button" className="secondary-button" disabled={page + 1 >= pageCount} onClick={() => setRequestedPage(page + 1)}>Next rows</button>
      </div>}
    </div>
    {!rowNumbers && <p className="help-text import-row-legacy">Refresh the selected range to enable row exclusions for this saved preview.</p>}
    <div className="mapping-table-wrap">
      <table className="mapping-table">
        <thead>
          <tr className="assignment-row">
            <th aria-label="Row exclusion column"></th><th>Assign</th>
            {headers.map((header, index) => <th key={`${header}-${index}`}>
              <select aria-label={`Role for ${header}`} value={roles[index] ?? "ignore"} onChange={(event) => setRole(index, event.target.value as ColumnRole)}>
                {roleOptions.map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}
              </select>
            </th>)}
          </tr>
          <tr><th scope="col">Exclude</th><th scope="col">Row</th>{headers.map((header, index) => <th scope="col" key={`${header}-${index}`}>{header}</th>)}</tr>
        </thead>
        <tbody>{rows.slice(first, first + pageSize).map((row, index) => {
          const rowIndex = first + index;
          const sourceRow = rowNumbers?.[rowIndex];
          const checked = sourceRow != null && excluded.has(sourceRow);
          return <tr key={sourceRow ?? rowIndex} className={checked ? "import-row-excluded" : undefined}>
            <td className="exclude-row"><input type="checkbox" aria-label={`Exclude file row ${sourceRow ?? rowIndex + 1}`} checked={checked} disabled={disabled || sourceRow == null} onChange={(event) => sourceRow != null && setExcluded(sourceRow, event.target.checked)} /></td>
            <td className="row-number" title={sourceRow == null ? "Preview row" : "Row in the original file"}>{sourceRow ?? rowIndex + 1}</td>
            {headers.map((_, columnIndex) => <td title={row[columnIndex] ?? ""} key={columnIndex}>{displayCell(row[columnIndex])}</td>)}
          </tr>;
        })}</tbody>
      </table>
    </div>
  </>;
}
