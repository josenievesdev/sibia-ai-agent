import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { alignNumericTableColumns } from "../lib/markdown-table-alignment";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [alignNumericTableColumns];
const DISALLOWED_ELEMENTS = ["img"];

const COMPONENTS: Components = {
  table({ node: _node, ...props }) {
    return (
      <div className="md-table" role="region" aria-label="Tabla de la respuesta" tabIndex={0}>
        <table {...props} />
      </div>
    );
  },
  a({ node: _node, children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

interface AssistantMarkdownProps {
  text: string;
}

/*
 * Muestra la respuesta del agente tal como llegó. El HTML que escriba el
 * modelo se descarta (skipHtml), las URL peligrosas se neutralizan y nunca
 * se inserta HTML sin procesar en el documento.
 */
export function AssistantMarkdown({ text }: AssistantMarkdownProps) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
        disallowedElements={DISALLOWED_ELEMENTS}
        unwrapDisallowed
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  );
}
