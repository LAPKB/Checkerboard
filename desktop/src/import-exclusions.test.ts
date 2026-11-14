import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportDataTable } from "./ImportDataTable";

const props = {
  headers: ["Drug A", "CFU"], rows: [["1", "50"], ["1", "50"]], rowNumbers: [12, 29],
  roles: ["drugA", "response"] as const, roleOptions: ["ignore", "drugA", "response"] as const,
  excludedRows: [] as number[], disabled: false, setExcluded: () => {}, setRole: () => {},
  displayCell: (value?: string) => value,
};
const render = (overrides: Partial<Parameters<typeof ImportDataTable>[0]> = {}) => renderToStaticMarkup(createElement(ImportDataTable, {
  ...props, roles: [...props.roles], roleOptions: [...props.roleOptions], ...overrides,
}));

describe("Import row exclusions", () => {
  it("places unchecked exclusion boxes before the source row and data columns", () => {
    const html = render();
    expect(html).toContain('<th scope="col">Exclude</th><th scope="col">Row</th>');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('aria-label="Exclude file row 12"');
    expect(html).toContain('aria-label="Exclude file row 29"');
    expect(html).toContain('aria-label="Role for CFU"');
  });

  it("keeps duplicate assay rows distinct by source row across filtered previews", () => {
    const html = render({ excludedRows: [29] });
    const rows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1].match(/<tr[\s\S]*?<\/tr>/g)!;
    expect(rows[0]).not.toContain('checked=""');
    expect(rows[1]).toContain('aria-label="Exclude file row 29" checked=""');
    expect(html).toContain("1 of 2 displayed-set rows excluded");
    const otherSet = render({ rows: [props.rows[1]], rowNumbers: [29], excludedRows: [29] });
    expect(otherSet).toContain('aria-label="Exclude file row 29" checked=""');
  });

  it("pages all imported rows and prevents ambiguous exclusions in legacy previews", () => {
    const rows = Array.from({ length: 125 }, () => ["1", "50"]);
    const html = render({ rows, rowNumbers: rows.map((_, i) => i + 2) });
    expect(html.match(/type="checkbox"/g)).toHaveLength(100);
    expect(html).toContain("Rows 1–100 of 125");
    expect(html).toContain("Next rows");
    const legacy = render({ rowNumbers: undefined });
    expect(legacy).toContain("Refresh the selected range");
    expect(legacy.match(/type="checkbox"[^>]*disabled=""/g)).toHaveLength(2);
  });
});
