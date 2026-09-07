# Preparación de Supabase para SIBIA

## Alcance

Estas migraciones preparan las 16 tablas del dominio de tienda y un acceso inicial de solo lectura para administradores activos. Las tools de lectura consumen este acceso, pero las migraciones no implementan chat, frontend ni flujos de escritura de inventario.

`productos.stock_actual` representa stock registrado. Los saldos de `lotes_productos` se consultan por separado. Ninguno de los dos valores demuestra por sí solo cantidad vendible y las cantidades de unidades incompatibles no deben agregarse.

## Archivos

| Orden | Archivo | Ejecución |
| --- | --- | --- |
| 1 | `supabase/migrations/20260906220000_create_store_schema.sql` | Ejecutar completo una vez. Crea estructura, restricciones, índices y vistas; antes del `COMMIT` habilita RLS y niega todo acceso API. |
| 2 | `supabase/migrations/20260906221000_configure_initial_access.sql` | Ejecutar completo una vez. Crea roles obligatorios, perfil Auth, RLS, políticas y grants. |
| Opcional | `supabase/seeds/optional_demo_data.sql` | Ejecutar completo solo en un entorno de demostración. Nunca es parte automática de las migraciones. |
| 3 | `supabase/verification/verify_store_security.sql` | Ejecutar completo después de las dos migraciones y revisar todos los resultados. Es de solo lectura. |

No ejecutar `database/reference/sibia-original.sql`. Ese archivo permanece como referencia histórica y mezcla una estructura insegura con datos ficticios.

Cada archivo usa su propia transacción. Se debe pegar y ejecutar el archivo completo desde SQL Editor, no seleccionar bloques aislados. Si una migración falla, revisar el error antes de continuar con la siguiente.

## Orden en SQL Editor

1. Abrir el proyecto nuevo en Supabase.
2. Abrir **SQL Editor** y crear una consulta nueva.
3. Pegar todo `20260906220000_create_store_schema.sql` y ejecutarlo.
4. Confirmar que la transacción terminó correctamente.
5. Crear otra consulta, pegar todo `20260906221000_configure_initial_access.sql` y ejecutarlo.
6. No ejecutar el seed si el proyecto contendrá datos reales.
7. Pegar y ejecutar completo `verify_store_security.sql`.

Las migraciones se prepararon para un proyecto vacío. No utilizan `IF NOT EXISTS` para ocultar una instalación parcial; una colisión debe investigarse en vez de ignorarse.

## Política inicial

- `anon`: sin privilegio `SELECT` sobre tablas o vistas del negocio.
- Usuario autenticado con rol de negocio `cliente`: las políticas no muestran filas.
- Usuario autenticado con rol de negocio `empleado`: las políticas no muestran filas.
- Usuario autenticado, activo y con rol de negocio `admin`: puede usar `SELECT` en las 16 tablas y cinco vistas.
- `anon` y `service_role` no reciben privilegios sobre las tablas de SIBIA. `authenticated` recibe únicamente `SELECT`, sujeto a RLS.
- El rol de negocio `admin` no es un rol PostgreSQL y no evita RLS.

La función `private.es_admin_activo()` es de solo lectura, no acepta UUID y comprueba exclusivamente `auth.uid()`. Su ejecución como función de propietario evita una política recursiva sobre `public.usuarios`. El esquema `private` no forma parte del esquema API público.

## Crear el usuario de prueba

Ejecutar primero las dos migraciones. Después:

1. En Supabase Dashboard abrir **Authentication > Users**.
2. Seleccionar **Add user** y crear un usuario con correo y contraseña.
3. Confirmar el correo desde Dashboard si la prueba no utilizará el flujo de correo real.
4. Copiar el UUID exacto mostrado por Supabase Auth.

El trigger crea automáticamente `public.usuarios` con rol `cliente`. No asigna `admin` desde metadatos ni por correo.

Comprobar el perfil desde SQL Editor, reemplazando el UUID de ejemplo por el UUID exacto:

```sql
SELECT
    u.id_usuario,
    u.correo,
    u.estado,
    r.nombre AS rol
FROM public.usuarios AS u
INNER JOIN public.roles AS r
    ON r.id_rol = u.id_rol
WHERE u.id_usuario = '00000000-0000-0000-0000-000000000000'::UUID;
```

El resultado inicial debe indicar `cliente`. Si no aparece una fila, no continuar con la asignación.

## Autorizar un admin de prueba

Desde SQL Editor, como operación administrativa, reemplazar el UUID y ejecutar únicamente para ese usuario:

```sql
UPDATE public.usuarios AS u
SET
    id_rol = r.id_rol,
    estado = 'activo'
FROM public.roles AS r
WHERE r.nombre = 'admin'
  AND u.id_usuario = '00000000-0000-0000-0000-000000000000'::UUID
RETURNING
    u.id_usuario,
    u.correo,
    u.estado,
    r.nombre AS rol;
```

Debe retornar exactamente una fila. No eliminar el filtro por UUID, no asignar admin a todos los usuarios y no convertir esta sentencia en una operación disponible para la aplicación.

## Simular RLS en SQL Editor

La siguiente prueba usa el UUID exacto del admin y simula el rol PostgreSQL `authenticated`. No sustituye una prueba posterior con un JWT real:

```sql
BEGIN;

SELECT set_config(
    'request.jwt.claim.sub',
    '00000000-0000-0000-0000-000000000000',
    TRUE
);

SET LOCAL ROLE authenticated;

SELECT private.es_admin_activo() AS es_admin_activo;
SELECT COUNT(*) AS roles_visibles FROM public.roles;
SELECT COUNT(*) AS productos_visibles FROM public.productos;

ROLLBACK;
```

Para el admin activo, `es_admin_activo` debe ser `TRUE` y `roles_visibles` debe ser `3`. La base actual contiene 49 productos reales: 18 bebidas, 16 snacks y 15 productos de panadería; proveedores, ventas y lotes siguen vacíos. Con un UUID de cliente o empleado, la función debe devolver `FALSE` y RLS debe producir cero filas visibles.

Una prueba con cero filas no demuestra por sí sola permisos de lectura. La autorización se confirma combinando el estado del perfil, los catálogos de políticas/grants y una consulta con un JWT real cuando exista el gateway de tienda.

## Verificaciones posteriores

Ejecutar completo `supabase/verification/verify_store_security.sql` y revisar:

- Las 16 tablas existen.
- Los roles `cliente`, `empleado` y `admin` existen.
- RLS está habilitado en cada tabla.
- Cada tabla tiene una política `SELECT` para admin activo y ninguna política de escritura.
- `anon` no tiene `SELECT`.
- `authenticated` tiene `SELECT`, pero no escritura; RLS decide si devuelve filas.
- `service_role` no tiene privilegios sobre las tablas o vistas de SIBIA.
- Las cinco vistas tienen `security_invoker=true`.
- La función del trigger de perfil no es ejecutable por `anon` ni `authenticated`.
- Las funciones antiguas de inventario no existen.
- Las tres claves foráneas compuestas de lote/producto están validadas.

Después de las migraciones, `npm run check:supabase` usa solo la publishable key y por tanto actúa como `anon`. Un resultado `permission_denied` será el comportamiento seguro esperado, no prueba de un problema de conexión. `npm run check:admin`, `npm run tools:console` y `npm run chat` solicitan credenciales de forma interactiva y consultan con la sesión de ese usuario; no usan una clave privilegiada ni persisten el JWT.

## Seed opcional

`supabase/seeds/optional_demo_data.sql` conserva ejemplos identificables del SQL original, pero corrige su repetición y limita las asociaciones a productos demo. No se ejecuta automáticamente.

El seed actualiza sus propios registros si se repite y contiene saldos iniciales ficticios sin movimientos de inventario. Esto es aceptable solo para demostraciones; no representa una importación ni una auditoría real.

## Limitaciones pendientes

- No existen funciones ni triggers para confirmar compras o ventas y modificar stock.
- No existen anulaciones, devoluciones ni ajustes transaccionales.
- La aplicación no tiene permisos de escritura, incluso para un admin de negocio.
- `stock_actual` y los saldos de lotes no se concilian automáticamente.
- No se define todavía cantidad vendible, FEFO ni bloqueo de lotes vencidos.
- `AJUSTE` permanece como valor estructural, pero no hay flujo autorizado que lo escriba.
- No se ha definido la matriz definitiva de empleado y cliente.
- El alta automática requiere usuarios Auth con correo.
- No se hace backfill automático de usuarios Auth creados antes del trigger.
- Las pruebas del archivo de verificación inspeccionan el catálogo del proyecto; una prueba real de extremo a extremo requerirá iniciar sesión y consultar con el JWT del usuario admin.
