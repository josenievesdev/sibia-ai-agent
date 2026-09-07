# Reglas de SIBIA

## Identidad y alcance

- El proyecto se llama SIBIA. No añadir sufijos de versión ni mezclar otros dominios comerciales.
- El dominio actual es una tienda real. No construir una plataforma multiempresa sin un requisito nuevo.
- El frontend futuro será React, pero no existe en esta etapa.
- No agregar ubicaciones; no son un requisito actual.

## Plataforma

- Backend Node.js y TypeScript en modo estricto.
- Mantener pocas dependencias y no introducir frameworks de agentes sin justificarlo con pruebas.
- Ollama usa exactamente `ministral-3:8b`. No cambiarlo ni descargar otros modelos.
- Supabase debe ser un proyecto nuevo. Nunca apuntar al proyecto anterior.
- Las credenciales solo entran por variables de entorno y nunca se imprimen, registran o versionan.
- No usar claves `service_role` para consultas iniciadas por usuarios. Propagar identidad y aplicar RLS.

## Datos y tools

- El modelo no genera ni ejecuta SQL arbitrario.
- Las tools iniciales son de lectura, tienen parámetros cerrados y devuelven resultados estructurados.
- El acceso al esquema de tienda debe permanecer separado del orquestador del agente.
- Diferenciar siempre resultados vacíos, datos no disponibles, ambigüedad, falta de permisos y errores técnicos.
- Respetar permisos del usuario en tablas, vistas, funciones y datos personales.
- No sumar cantidades de unidades de medida incompatibles.
- `estado = activo` y `stock_actual > 0` son conceptos distintos.
- Las referencias conversacionales se resuelven por sesión mediante identificadores estables. Pedir aclaración si hay más de una referencia plausible.
- No optimizar antes de probar búsqueda, selección de tools, continuidad conversacional y fidelidad de datos.

## SQL

- `database/reference/sibia-original.sql` es una copia de referencia y no una migración ejecutable.
- No modificar el SQL de referencia. Crear futuras migraciones en una ruta separada después de aprobar el diseño corregido.
- No ejecutar ni subir SQL a Supabase sin autorización explícita.
- Los datos semilla son ficticios y nunca se presentan como información real del negocio.
- Las migraciones ejecutables están ordenadas en `supabase/migrations`; los seeds opcionales permanecen fuera de esa ruta.
- La política inicial permite solo lectura a un usuario autenticado con perfil activo y rol de negocio `admin`.
- `anon`, `service_role`, cliente y empleado no tienen acceso inicial a datos de SIBIA; no ampliar permisos sin una matriz aprobada.
- La aplicación no tiene escrituras habilitadas. No recrear los triggers o funciones de inventario originales antes de diseñar confirmaciones, reversos y ajustes transaccionales.

## Verificación

- Antes de entregar cambios de backend ejecutar `npm run typecheck`, `npm test` y `npm run build`.
- Verificar `/health` sin asumir el estado de integraciones externas.
- Ejecutar los checks de integración que permita la configuración disponible y reportar su resultado real.
- No afirmar que Supabase funciona si faltan URL, clave, esquema, permisos o una comprobación ejecutada.
