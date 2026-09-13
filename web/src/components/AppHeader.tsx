import { BrandSymbol } from "./BrandSymbol";

interface AppHeaderProps {
  onSignOut(): void;
}

export function AppHeader({ onSignOut }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <BrandSymbol className="brand__symbol" />
        <span className="brand__word">SIBIA</span>
      </div>
      <button type="button" className="app-header__signout" onClick={onSignOut}>
        Cerrar sesión
      </button>
    </header>
  );
}
