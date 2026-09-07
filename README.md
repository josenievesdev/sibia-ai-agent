# SIBIA

Base inicial del backend de SIBIA, un asistente empresarial con IA para una tienda real. Esta etapa incorpora la API HTTP, comprobaciones de infraestructura, cinco tools de lectura y un primer chat conversacional ejecutable desde consola; todavía no incluye frontend ni un endpoint de chat.

## Requisitos comprobados

- Node.js 24 o superior.
- npm.
- Ollama instalado localmente.
- Modelo exacto `ministral-3:8b` disponible en Ollama.
- Un nuevo proyecto de Supabase, cuando se vaya a conectar la base de datos.

SIBIA no descarga modelos ni instala herramientas globales. La configuración rechaza otro valor de `OLLAMA_MODEL` para evitar cambiar accidentalmente el modelo acordado.

## Inicio en Windows PowerShell

```powershell
Set-Location -LiteralPath "C:\Users\jo5e\Desktop\Dev\sibia-ai-agent"
npm install
Copy-Item -LiteralPath ".env.example" -Destination ".env"
npm run dev
```

La API escucha de forma predeterminada en `http://127.0.0.1:3000`.

En otra terminal:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/health"
Invoke-RestMethod -Uri "http://127.0.0.1:3000/checks/ollama"
```

`GET /health` solo confirma que el proceso HTTP funciona. No consulta dependencias externas y las declara como `not_checked` o `not_configured`.

## Configuración

| Variable | Valor inicial | Uso |
| --- | --- | --- |
| `APP_HOST` | `127.0.0.1` | Interfaz donde escucha Fastify. |
| `PORT` | `3000` | Puerto HTTP. |
| `LOG_LEVEL` | `info` | Nivel de logs de Fastify. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | URL configurable de Ollama. |
| `OLLAMA_MODEL` | `ministral-3:8b` | Modelo fijo confirmado para SIBIA. |
| `OLLAMA_CHAT_TIMEOUT_MS` | `120000` | Tiempo límite de cada llamada del chat a Ollama. |
| `INTEGRATION_CHECK_TIMEOUT_MS` | `5000` | Tiempo límite de cada comprobación. |
| `SUPABASE_URL` | vacío | URL del nuevo proyecto de Supabase. |
| `SUPABASE_PUBLISHABLE_KEY` | vacío | Clave pública del nuevo proyecto. Nunca una `service_role` key. |

El backend arranca si las dos variables de Supabase están vacías. Si solo se configura una, falla al iniciar con un mensaje explícito para evitar una configuración parcial.

No se deben guardar secretos en `.env.example`, Git, logs ni documentación. `.env` está ignorado por Git.

## Comandos

```powershell
npm run dev
npm run chat
npm run typecheck
npm run build
npm test
npm start
npm run check:health
npm run check:ollama
npm run check:supabase
npm run check:admin
npm run tools:console
```

En un checkout limpio, ejecutar `npm run build` antes de `npm start` para generar `dist`.

`check:supabase` devuelve `not_configured` sin intentar una conexión cuando faltan las variables y termina con código `2` para que la automatización no lo interprete como una integración comprobada. Una vez configurado, distingue conexión, tabla ausente, autenticación rechazada, permisos insuficientes y una consulta sin filas visibles. Solo declara acceso verificado cuando obtiene al menos una fila de `public.roles`; una respuesta vacía queda como `access_unverified` porque también podría deberse a RLS.

`check:admin` solicita credenciales sin mostrar la contraseña, inicia una sesión de usuario y comprueba la lectura de roles y productos bajo RLS. `tools:console` reutiliza el mismo flujo de sesión y permite invocar manualmente `buscar_productos`, `listar_productos`, `consultar_stock`, `consultar_proveedores_producto` y `resumen_inventario`. Ninguno de los dos comandos persiste la sesión.

`chat` solicita las credenciales una sola vez y abre una conversación libre con Ollama. El agente decide cuándo usar las cinco tools, conserva referencias y paginación en memoria, limita cada turno a cinco rondas de tools y termina con `/salir`. La contraseña, las claves y los tokens de Supabase no se envían a Ollama ni se guardan; el cierre afecta solo a la sesión local de la consola.

Para comprobar el nuevo proyecto sin escribir secretos en archivos:

```powershell
$env:SUPABASE_URL = "https://ID-DEL-NUEVO-PROYECTO.supabase.co"
$env:SUPABASE_PUBLISHABLE_KEY = "CLAVE-PUBLICA-DEL-NUEVO-PROYECTO"
npm run check:supabase
```

## Endpoints actuales

| Método y ruta | Responsabilidad |
| --- | --- |
| `GET /health` | Disponibilidad del proceso HTTP, sin comprobar servicios externos. |
| `GET /checks/ollama` | Conexión a Ollama y presencia exacta de `ministral-3:8b`. |
| `GET /checks/supabase` | Configuración, conexión y lectura controlada de `public.roles`. |

Los checks distinguen `available`, `not_configured`, `configuration_error`, `schema_missing`, `authentication_failed`, `permission_denied`, `access_unverified` y `unavailable`. Las rutas de comprobación son operativas y deberán protegerse o deshabilitarse antes de exponer la API públicamente.

## Base de datos

El SQL recibido se conserva sin convertirlo en migración en:

```text
database/reference/sibia-original.sql
```

No debe ejecutarse directamente. Los hallazgos y correcciones propuestas están en [`docs/sql-analysis.md`](docs/sql-analysis.md). Las futuras migraciones ejecutables deberán vivir en una ruta separada y crearse solo después de aprobar esas correcciones.

Los registros incluidos en el SQL son datos de prueba. No son evidencia sobre inventario, clientes, precios ni operaciones reales de la tienda.

La base actual contiene 49 productos reales: 18 bebidas, 16 snacks y 15 productos de panadería. Proveedores, ventas y lotes siguen vacíos.

Las migraciones ejecutables están en `supabase/migrations`. El orden de SQL Editor, la política RLS inicial, la creación de un admin de prueba y las verificaciones están documentados en [`docs/supabase-database-setup.md`](docs/supabase-database-setup.md).

## Arquitectura de esta etapa

- `src/config`: lectura y validación de variables de entorno.
- `src/http`: construcción de Fastify, rutas y arranque del servidor.
- `src/integrations/ollama`: cliente de comprobación de Ollama.
- `src/integrations/supabase`: creación del cliente y comprobación del esquema.
- `src/agent`: orquestación de Ollama, tools y memoria conversacional acotada.
- `src/store`: contrato del gateway de tienda y consultas predeterminadas a Supabase.
- `src/tools`: contratos de entrada cerrados y resultados estructurados para lectura.
- `src/console`: entrada interactiva, conversación libre y ciclo de vida de sesiones de usuario.
- `src/scripts`: verificaciones y consola de tools sin levantar un servidor real.
- `database/reference`: material original no ejecutable.
- `docs`: arquitectura prevista y análisis del esquema.

Los límites implementados para el agente, las tools, el acceso al dominio y el estado por sesión se describen en [`docs/architecture.md`](docs/architecture.md).
