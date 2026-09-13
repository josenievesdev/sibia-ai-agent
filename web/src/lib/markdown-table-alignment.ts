/*
 * Plugin rehype de presentación: alinea a la derecha las columnas de una
 * tabla cuyas celdas son cantidades o precios. No cambia el contenido ni
 * interpreta la respuesta, y respeta cualquier alineación escrita en GFM.
 */

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

const NUMERIC_CELL =
  /^(?:[$€£]|COP|USD)?\s?[-+]?\d[\d.,]*(?:\s?(?:%|[\p{L}.]{1,14}))?$/u;

function elements(node: HastNode, tagName: string): HastNode[] {
  const found: HastNode[] = [];
  for (const child of node.children ?? []) {
    if (child.type !== "element") {
      continue;
    }
    if (child.tagName === tagName) {
      found.push(child);
    } else if (child.tagName !== "table") {
      found.push(...elements(child, tagName));
    }
  }
  return found;
}

function cells(row: HastNode): HastNode[] {
  return (row.children ?? []).filter(
    (child) =>
      child.type === "element" && (child.tagName === "td" || child.tagName === "th"),
  );
}

function textContent(node: HastNode): string {
  if (node.type === "text") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(textContent).join("");
}

function markNumeric(cell: HastNode): void {
  const properties = (cell.properties ??= {});
  if (properties.align !== undefined && properties.align !== null) {
    return;
  }
  const className = Array.isArray(properties.className) ? properties.className : [];
  properties.className = [...className, "md-numeric"];
}

function alignTable(table: HastNode): void {
  const headRows = elements(table, "thead").flatMap((head) => elements(head, "tr"));
  const bodyRows = elements(table, "tbody").flatMap((body) => elements(body, "tr"));
  const columns = Math.max(0, ...bodyRows.map((row) => cells(row).length));

  for (let column = 0; column < columns; column += 1) {
    const values = bodyRows
      .map((row) => cells(row)[column])
      .filter((cell): cell is HastNode => cell !== undefined)
      .map((cell) => textContent(cell).trim())
      .filter((value) => value !== "");
    if (values.length === 0 || !values.every((value) => NUMERIC_CELL.test(value))) {
      continue;
    }
    for (const row of [...headRows, ...bodyRows]) {
      const cell = cells(row)[column];
      if (cell !== undefined) {
        markNumeric(cell);
      }
    }
  }
}

function visit(node: HastNode): void {
  if (node.type === "element" && node.tagName === "table") {
    alignTable(node);
  }
  for (const child of node.children ?? []) {
    visit(child);
  }
}

export function alignNumericTableColumns() {
  return (tree: HastNode): void => {
    visit(tree);
  };
}
