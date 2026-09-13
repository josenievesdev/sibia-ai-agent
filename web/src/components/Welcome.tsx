import { WELCOME_TEXT } from "../lib/welcome";
import { BrandSymbol } from "./BrandSymbol";

interface WelcomeProps {
  greeting: string;
}

export function Welcome({ greeting }: WelcomeProps) {
  return (
    <div className="welcome">
      <BrandSymbol className="welcome__symbol" />
      <div className="welcome__copy">
        <h1 className="welcome__title">{greeting}</h1>
        <p className="welcome__text">{WELCOME_TEXT}</p>
      </div>
    </div>
  );
}
