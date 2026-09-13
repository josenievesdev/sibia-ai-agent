import { BrandSymbol } from "./BrandSymbol";

/*
 * Único estado de espera: describe lo que ocurre de verdad, sin inventar
 * pasos intermedios del agente.
 */
export function ConsultingIndicator() {
  return (
    <div className="consulting" role="status">
      <span className="brand-pulse" aria-hidden="true">
        <BrandSymbol className="brand-pulse__symbol" />
      </span>
      <span>SIBIA está consultando la información…</span>
    </div>
  );
}
