import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssistantMarkdown } from "../src/components/AssistantMarkdown";

describe("respuesta en Markdown", () => {
  it("renderiza el formato permitido sin interpretar HTML del modelo", () => {
    const text = [
      "## Resumen",
      "",
      "Texto con **negrita** y `codigo`.",
      "",
      "- uno",
      "- dos",
      "",
      "1. primero",
      "",
      "<script>window.inyectado = true</script>",
      "",
      '<img src="x" onerror="window.inyectado = true">',
      "",
      'Texto <b onclick="window.inyectado = true">marcado</b> al final.',
      "",
      "[enlace](javascript:window.inyectado=true)",
    ].join("\n");

    const { container } = render(<AssistantMarkdown text={text} />);

    expect(screen.getByRole("heading", { level: 2, name: "Resumen" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("negrita");
    expect(container.querySelector("code")?.textContent).toBe("codigo");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelector("ol > li")?.textContent).toBe("primero");
    expect(container.querySelector("script, img, b, [onclick], [onerror]")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/javascript/iu);
    expect((window as { inyectado?: boolean }).inyectado).toBeUndefined();
  });

  it("muestra una tabla GFM desplazable con cantidades y precios alineados", () => {
    const text = [
      "Hoy hay tres productos por debajo del mínimo:",
      "",
      "| Producto | Existencias | Precio |",
      "| --- | --- | --- |",
      "| Gaseosa 2.5 L | 4 | $ 6.900 |",
      "| Pan tajado | 7 | $ 4.500 |",
      "| Caramelos surtidos | 12 unidades | $1.200 |",
    ].join("\n");

    render(<AssistantMarkdown text={text} />);

    const region = screen.getByRole("region", { name: "Tabla de la respuesta" });
    const table = within(region).getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Producto",
      "Existencias",
      "Precio",
    ]);
    expect(headers[0]?.className ?? "").not.toContain("md-numeric");
    expect(headers[2]?.className).toContain("md-numeric");

    const firstRow = within(table).getAllByRole("row")[1]!;
    const cells = within(firstRow).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["Gaseosa 2.5 L", "4", "$ 6.900"]);
    expect(cells[0]?.className ?? "").not.toContain("md-numeric");
    expect(cells[1]?.className).toContain("md-numeric");
    expect(cells[2]?.className).toContain("md-numeric");
  });

  it("respeta la alineación escrita explícitamente en la tabla", () => {
    render(<AssistantMarkdown text={"| Producto | Stock |\n| --- | :--- |\n| Agua | 3 |"} />);

    const cell = screen.getAllByRole("cell")[1]!;
    expect(cell.className).not.toContain("md-numeric");
    expect(cell.style.textAlign).toBe("left");
  });
});
