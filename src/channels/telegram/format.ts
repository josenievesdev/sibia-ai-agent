export const TELEGRAM_TEXT_LIMIT = 4_096;

function inlineText(value: string): string {
  const protectedValues: string[] = [];
  const protect = (content: string): string => {
    const index = protectedValues.push(content) - 1;
    return `\u0001${index}\u0002`;
  };

  const formatted = value
    .replace(/`([^`\n]+)`/gu, (_match, content: string) => protect(content))
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/gu,
      (_match, label: string, destination: string) =>
        `${label} (${protect(destination)})`,
    )
    .replace(
      /(?<![\p{L}\p{N}])\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*(?![\p{L}\p{N}])/gu,
      "$1",
    )
    .replace(
      /(?<![\p{L}\p{N}_])__([^\s_](?:[^_\n]*?[^\s_])?)__(?![\p{L}\p{N}_])/gu,
      "$1",
    )
    .replace(/~~([^~\n]+)~~/gu, "$1");

  return formatted.replace(/\u0001(\d+)\u0002/gu, (_match, rawIndex: string) => {
    return protectedValues[Number(rawIndex)] ?? "";
  });
}

function tableCells(line: string): string[] | null {
  let value = line.trim();
  if (!value.includes("|")) {
    return null;
  }
  if (value.startsWith("|")) {
    value = value.slice(1);
  }
  if (value.endsWith("|")) {
    value = value.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(cells: readonly string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s+/gu, "")))
  );
}

function convertTables(lines: readonly string[]): string[] {
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const headers = tableCells(lines[index]!);
    const separator =
      index + 1 < lines.length ? tableCells(lines[index + 1]!) : null;
    if (
      headers === null ||
      separator === null ||
      headers.length !== separator.length ||
      !isTableSeparator(separator)
    ) {
      output.push(lines[index]!);
      continue;
    }

    let rowIndex = index + 2;
    let convertedRows = 0;
    while (rowIndex < lines.length) {
      const row = tableCells(lines[rowIndex]!);
      if (row === null || row.length !== headers.length) {
        break;
      }

      output.push(`- ${headers[0] || "Campo 1"}: ${row[0] ?? ""}`);
      for (let column = 1; column < headers.length; column += 1) {
        output.push(
          `  ${headers[column] || `Campo ${column + 1}`}: ${row[column] ?? ""}`,
        );
      }
      convertedRows += 1;
      rowIndex += 1;
    }

    if (convertedRows === 0) {
      output.push(lines[index]!, lines[index + 1]!);
      index += 1;
      continue;
    }
    index = rowIndex - 1;
  }

  return output;
}

interface PreparedLine {
  literal: boolean;
  value: string;
}

function prepareLines(lines: readonly string[]): PreparedLine[] {
  const prepared: PreparedLine[] = [];
  let outsideFence: string[] = [];
  let insideFence = false;

  const flushOutside = (): void => {
    prepared.push(
      ...convertTables(outsideFence).map((value) => ({ literal: false, value })),
    );
    outsideFence = [];
  };

  for (const line of lines) {
    if (/^\s*(?:`{3,}|~{3,}).*$/u.test(line)) {
      if (!insideFence) {
        flushOutside();
      }
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      prepared.push({ literal: true, value: line });
    } else {
      outsideFence.push(line);
    }
  }
  flushOutside();
  return prepared;
}

export function formatTelegramText(markdown: string): string {
  const safe = markdown
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  const output: string[] = [];

  for (const line of prepareLines(safe.split("\n"))) {
    const value = line.literal
      ? line.value
      : inlineText(
          line.value
            .replace(/^\s{0,3}#{1,6}\s+/u, "")
            .replace(/^\s{0,3}>\s?/u, ""),
        );
    output.push(value.replace(/[ \t]+$/u, ""));
  }

  return output.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function splitTelegramText(
  text: string,
  limit = TELEGRAM_TEXT_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("El límite de Telegram debe ser un entero positivo.");
  }

  let remaining = text.trim();
  if (remaining === "") {
    return [];
  }

  const chunks: string[] = [];
  while (remaining.length > limit) {
    let boundary = -1;
    for (let index = limit; index > 0; index -= 1) {
      if (/\s/u.test(remaining[index] ?? "")) {
        boundary = index;
        break;
      }
    }
    if (boundary < 1) {
      throw new RangeError(
        "La respuesta contiene una palabra que supera el límite de Telegram.",
      );
    }

    const chunk = remaining.slice(0, boundary).trimEnd();
    if (chunk === "") {
      throw new RangeError("No fue posible dividir la respuesta de Telegram.");
    }
    chunks.push(chunk);
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining !== "") {
    chunks.push(remaining);
  }
  return chunks;
}
