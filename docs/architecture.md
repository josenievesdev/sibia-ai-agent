# Arquitectura inicial

## Alcance implementado

La etapa actual establece ocho límites ejecutables:

1. `config`: valida entorno y evita configuraciones parciales o un modelo distinto al acordado.
2. `http`: expone salud del proceso y comprobaciones explícitas de integraciones.
3. `integrations/supabase`: encapsula el SDK de Supabase y no conoce HTTP ni al agente.
4. `integrations/ollama-check.ts`: comprueba la disponibilidad de Ollama y del modelo.
5. `ai`: ejecuta el ciclo acotado modelo/tools, habla con Ollama por HTTP, contiene el prompt del sistema y conserva estado compacto por sesión.
6. `store`: define el gateway de tienda e implementa consultas predeterminadas a Supabase.
7. `tools`: valida entradas cerradas y traduce datos, vacíos y errores a resultados estructurados.
8. `console`: gestiona entrada oculta, autenticación, conversación libre y cierre de sesiones interactivas.

El primer chat funciona mediante `npm run chat`; usa exactamente `ministral-3:8b`, las cinco tools de lectura y la sesión Supabase del usuario bajo RLS. No hay todavía endpoint de chat ni frontend. `/health` tampoco ejecuta checks remotos, por lo que una caída de Ollama o la ausencia de Supabase no impiden arrancar el backend.

## Flujo del chat

La dirección de dependencias implementada es:

```text
consola -> agente/orquestador -> catálogo cerrado de tools -> gateway de tienda -> Supabase
                             \-> estado de conversación por sesión
                             \-> cliente de Ollama
```

- El orquestador decide si responde, pide aclaración o invoca una tool; no conoce tablas ni construye SQL.
- El orquestador invoca las tools por sus nombres estables y respeta sus esquemas de entrada cerrados y resultados tipados.
- El gateway de tienda contiene consultas predeterminadas al esquema SIBIA. Esta separación permitirá adaptar otro esquema en el futuro sin volver genérico al agente actual.
- El cliente de Supabase para datos de usuario deberá recibir el JWT del usuario por solicitud. La publishable key identifica la aplicación, no autoriza por sí sola datos privados.
- No se utilizará una tool `execute_sql`, texto SQL producido por el modelo ni una `service_role` key para saltar RLS.

El agente y la consola no dependen entre sí mediante detalles de terminal, de modo que el mismo agente podrá componerse después desde HTTP. El endpoint de chat, la validación de JWT por solicitud y React siguen pendientes.

## Estado conversacional por sesión

El estado actual en memoria contiene:

```text
candidates: [{ id, nombre, codigoReferencia, categoriaId }]
selectedProduct
lastList: { source, filtros, pagina, tamanoPagina, totalPaginas }
history: últimos mensajes acotados
```

Así, “Busca agua” guarda candidatos reales, “La segunda” selecciona un UUID estable y “¿cuánto queda?” consulta ese producto. “Muéstrame más” reutiliza filtros y avanza la página solo después de una lista paginada. Si falta una opción o hay varias interpretaciones, el agente pide aclaración.

Cada ejecución de consola crea una sesión independiente. El historial, los candidatos, la selección y los tokens viven solo en memoria y se pierden al salir. La persistencia y coordinación entre réplicas se elegirán cuando exista el endpoint de chat y requisitos de retención.

## Contrato de resultados

Las tools de lectura usan un sobre común equivalente a:

```json
{
  "tool": "buscar_productos",
  "status": "ok | empty | invalid_input | not_available | forbidden | error",
  "data": [],
  "meta": {
    "total": 49,
    "cantidadEntregada": 10,
    "pagina": 1,
    "tamanoPagina": 10,
    "totalPaginas": 5,
    "hayMasPaginas": true
  },
  "error": null
}
```

- `empty`: la consulta se ejecutó correctamente y no encontró filas.
- `not_available`: el esquema no contiene el dato solicitado o la integración no está configurada.
- `invalid_input`: la entrada no cumple el esquema cerrado de la tool.
- `forbidden`: el usuario está autenticado, pero su rol no permite el dato.
- `error`: falló la conexión o la consulta; nunca se transforma en una lista vacía.

`ambiguous` queda reservado para el orquestador conversacional: las búsquedas actuales devuelven candidatos ordenados y no eligen uno de forma implícita.

React recibirá filas y metadatos de paginación, no texto preformateado como única respuesta. Las cantidades conservarán `unidad_medida`; cualquier agregado deberá agrupar por unidad compatible.

## Autenticación y permisos

La tabla de roles de negocio no sustituye RLS. La consola actual autentica una vez, conserva el cliente solo en memoria, ejecuta todas las tools con esa identidad y cierra únicamente la sesión local al salir. El flujo futuro para React será:

1. React autentica mediante Supabase Auth.
2. La API valida la identidad y conserva el token solo durante la solicitud.
3. El gateway crea o utiliza un cliente Supabase con el JWT del usuario.
4. RLS y las reglas de la tool aplican defensa en profundidad.

Los endpoints operativos `/checks/*` no deben quedar públicos en producción. Sus respuestas actuales no incluyen URL ni claves, pero revelan disponibilidad de infraestructura.
