-- SIBIA: verificación posterior a las dos migraciones.
-- Ejecutar completo desde SQL Editor. Todas las consultas son de solo lectura.
-- Las columnas llamadas cumple o *_esperado deben devolver TRUE.

BEGIN TRANSACTION READ ONLY;

-- 1. Deben existir las 16 tablas del dominio.
WITH tablas_esperadas(tabla) AS (
    VALUES
        ('roles'),
        ('usuarios'),
        ('sesiones_auditoria'),
        ('clientes'),
        ('categorias'),
        ('productos'),
        ('proveedores'),
        ('productos_proveedores'),
        ('lotes_productos'),
        ('compras_encabezado'),
        ('compras_detalle'),
        ('ventas_encabezado'),
        ('ventas_detalle'),
        ('promociones'),
        ('productos_promociones'),
        ('movimientos_inventario')
)
SELECT
    'tablas_del_dominio' AS verificacion,
    COUNT(*) = 16
        AND BOOL_AND(TO_REGCLASS(FORMAT('public.%I', tabla)) IS NOT NULL)
        AS cumple,
    ARRAY_AGG(tabla ORDER BY tabla)
        FILTER (WHERE TO_REGCLASS(FORMAT('public.%I', tabla)) IS NULL)
        AS faltantes
FROM tablas_esperadas;

-- 2. Los tres roles de referencia son obligatorios, no datos demo.
WITH roles_esperados(nombre) AS (
    VALUES ('cliente'), ('empleado'), ('admin')
)
SELECT
    e.nombre,
    r.id_rol IS NOT NULL AS existe
FROM roles_esperados AS e
LEFT JOIN public.roles AS r
    ON r.nombre = e.nombre
ORDER BY e.nombre;

-- 3. Cada tabla debe tener RLS y una única política SELECT para authenticated.
WITH tablas_esperadas(tabla) AS (
    VALUES
        ('roles'),
        ('usuarios'),
        ('sesiones_auditoria'),
        ('clientes'),
        ('categorias'),
        ('productos'),
        ('proveedores'),
        ('productos_proveedores'),
        ('lotes_productos'),
        ('compras_encabezado'),
        ('compras_detalle'),
        ('ventas_encabezado'),
        ('ventas_detalle'),
        ('promociones'),
        ('productos_promociones'),
        ('movimientos_inventario')
)
SELECT
    e.tabla,
    COALESCE(c.relrowsecurity, FALSE) AS rls_habilitado,
    (
        SELECT COUNT(*) = 1
        FROM pg_policies AS p
        WHERE p.schemaname = 'public'
          AND p.tablename = e.tabla
    ) AS exactamente_una_politica,
    (
        SELECT COUNT(*) = 1
        FROM pg_policies AS p
        WHERE p.schemaname = 'public'
          AND p.tablename = e.tabla
          AND p.policyname = 'admin_activo_select_' || e.tabla
          AND p.cmd = 'SELECT'
          AND 'authenticated' = ANY (p.roles::TEXT[])
          AND p.qual LIKE '%es_admin_activo%'
          AND p.qual NOT ILIKE '% OR %'
          AND p.qual NOT ILIKE '%not%'
          AND p.qual NOT ILIKE '%false%'
          AND p.qual NOT ILIKE '%true%'
    ) AS politica_select_admin,
    NOT EXISTS (
        SELECT 1
        FROM pg_policies AS p
        WHERE p.schemaname = 'public'
          AND p.tablename = e.tabla
          AND p.cmd <> 'SELECT'
    ) AS sin_politicas_escritura,
    (
        SELECT p.qual
        FROM pg_policies AS p
        WHERE p.schemaname = 'public'
          AND p.tablename = e.tabla
        ORDER BY p.policyname
        LIMIT 1
    ) AS definicion_rls
FROM tablas_esperadas AS e
LEFT JOIN pg_namespace AS n
    ON n.nspname = 'public'
LEFT JOIN pg_class AS c
    ON c.relnamespace = n.oid
   AND c.relname = e.tabla
   AND c.relkind = 'r'
ORDER BY e.tabla;

-- 4. anon no tiene datos; authenticated solo tiene privilegio SELECT.
-- RLS decide cuáles usuarios authenticated ven filas.
WITH tablas_esperadas(tabla) AS (
    VALUES
        ('roles'),
        ('usuarios'),
        ('sesiones_auditoria'),
        ('clientes'),
        ('categorias'),
        ('productos'),
        ('proveedores'),
        ('productos_proveedores'),
        ('lotes_productos'),
        ('compras_encabezado'),
        ('compras_detalle'),
        ('ventas_encabezado'),
        ('ventas_detalle'),
        ('promociones'),
        ('productos_promociones'),
        ('movimientos_inventario')
), objetos AS (
    SELECT
        tabla,
        TO_REGCLASS(FORMAT('public.%I', tabla))::OID AS objeto_oid
    FROM tablas_esperadas
)
SELECT
    tabla,
    COALESCE(NOT HAS_TABLE_PRIVILEGE(
        'anon',
        objeto_oid,
        'SELECT'
    ), FALSE) AS anon_sin_select,
    COALESCE(HAS_TABLE_PRIVILEGE(
        'authenticated',
        objeto_oid,
        'SELECT'
    ), FALSE) AS authenticated_con_select,
    COALESCE(NOT HAS_TABLE_PRIVILEGE(
        'authenticated',
        objeto_oid,
        'INSERT'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'authenticated',
        objeto_oid,
        'UPDATE'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'authenticated',
        objeto_oid,
        'DELETE'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'authenticated',
        objeto_oid,
        'TRUNCATE'
    ), FALSE) AS authenticated_sin_escritura,
    COALESCE(NOT HAS_TABLE_PRIVILEGE(
        'service_role',
        objeto_oid,
        'SELECT'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'service_role',
        objeto_oid,
        'INSERT'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'service_role',
        objeto_oid,
        'UPDATE'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'service_role',
        objeto_oid,
        'DELETE'
    )
    AND NOT HAS_TABLE_PRIVILEGE(
        'service_role',
        objeto_oid,
        'TRUNCATE'
    ), FALSE) AS service_role_sin_privilegios
FROM objetos
ORDER BY tabla;

-- 5. Las cinco vistas deben ejecutar con permisos del invocador.
WITH vistas_esperadas(vista) AS (
    VALUES
        ('vista_inventario'),
        ('vista_productos_stock_bajo'),
        ('vista_productos_por_vencer'),
        ('vista_promociones_activas'),
        ('vista_ventas_resumen')
)
SELECT
    e.vista,
    c.oid IS NOT NULL AS existe,
    COALESCE(c.reloptions, ARRAY[]::TEXT[])
        @> ARRAY['security_invoker=true'] AS security_invoker,
    COALESCE(NOT HAS_TABLE_PRIVILEGE(
        'anon',
        c.oid,
        'SELECT'
    ), FALSE) AS anon_sin_select,
    COALESCE(HAS_TABLE_PRIVILEGE(
        'authenticated',
        c.oid,
        'SELECT'
    ), FALSE) AS authenticated_con_select,
    COALESCE(NOT HAS_TABLE_PRIVILEGE(
        'service_role',
        c.oid,
        'SELECT'
    ), FALSE) AS service_role_sin_select
FROM vistas_esperadas AS e
LEFT JOIN pg_namespace AS n
    ON n.nspname = 'public'
LEFT JOIN pg_class AS c
    ON c.relnamespace = n.oid
   AND c.relname = e.vista
   AND c.relkind = 'v'
ORDER BY e.vista;

-- 6. Funciones y permisos de ejecución.
WITH funciones AS (
    SELECT
        TO_REGPROCEDURE('private.es_admin_activo()')::OID
            AS funcion_admin,
        TO_REGPROCEDURE('public.crear_perfil_usuario()')::OID
            AS funcion_perfil
)
SELECT
    funcion_admin IS NOT NULL
        AS funcion_admin_existe,
    COALESCE(HAS_SCHEMA_PRIVILEGE(
        'authenticated',
        TO_REGNAMESPACE('private')::OID,
        'USAGE'
    ), FALSE) AS authenticated_usa_private,
    COALESCE(HAS_FUNCTION_PRIVILEGE(
        'authenticated',
        funcion_admin,
        'EXECUTE'
    ), FALSE) AS authenticated_ejecuta_comprobacion,
    COALESCE(NOT HAS_FUNCTION_PRIVILEGE(
        'anon',
        funcion_admin,
        'EXECUTE'
    ), FALSE) AS anon_no_ejecuta_comprobacion,
    COALESCE(NOT HAS_FUNCTION_PRIVILEGE(
        'service_role',
        funcion_admin,
        'EXECUTE'
    ), FALSE) AS service_role_no_ejecuta_comprobacion,
    funcion_perfil IS NOT NULL
        AS funcion_perfil_existe,
    COALESCE(NOT HAS_FUNCTION_PRIVILEGE(
        'anon',
        funcion_perfil,
        'EXECUTE'
    ), FALSE) AS anon_no_ejecuta_perfil,
    COALESCE(NOT HAS_FUNCTION_PRIVILEGE(
        'authenticated',
        funcion_perfil,
        'EXECUTE'
    ), FALSE) AS authenticated_no_ejecuta_perfil,
    COALESCE(NOT HAS_FUNCTION_PRIVILEGE(
        'service_role',
        funcion_perfil,
        'EXECUTE'
    ), FALSE) AS service_role_no_ejecuta_perfil
FROM funciones;

-- Ambas funciones SECURITY DEFINER deben pertenecer a un rol confiable y
-- fijar un search_path vacío.
WITH funciones_esperadas(esquema, funcion) AS (
    VALUES
        ('private', 'es_admin_activo'),
        ('public', 'crear_perfil_usuario')
)
SELECT
    e.esquema,
    e.funcion,
    p.oid IS NOT NULL AS existe,
    COALESCE(p.prosecdef, FALSE) AS security_definer,
    COALESCE(
        p.proconfig @> ARRAY['search_path=']::TEXT[]
        OR p.proconfig @> ARRAY['search_path=""']::TEXT[],
        FALSE
    ) AS search_path_vacio,
    COALESCE(r.rolsuper OR r.rolbypassrls, FALSE) AS propietario_confiable,
    r.rolname AS propietario,
    p.proconfig AS configuracion
FROM funciones_esperadas AS e
LEFT JOIN pg_namespace AS n
    ON n.nspname = e.esquema
LEFT JOIN pg_proc AS p
    ON p.pronamespace = n.oid
   AND p.proname = e.funcion
   AND p.pronargs = 0
LEFT JOIN pg_roles AS r
    ON r.oid = p.proowner
ORDER BY e.esquema, e.funcion;

-- 7. Las funciones y triggers de inventario inseguros no se migraron.
SELECT
    NOT EXISTS (
        SELECT 1
        FROM pg_proc AS p
        INNER JOIN pg_namespace AS n
            ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'actualizar_stock',
              'actualizar_stock_lote',
              'registrar_movimiento_inventario',
              'procesar_compra_detalle',
              'procesar_venta_detalle'
          )
    ) AS funciones_inventario_omitidas,
    NOT EXISTS (
        SELECT 1
        FROM pg_trigger AS t
        INNER JOIN pg_class AS c
            ON c.oid = t.tgrelid
        INNER JOIN pg_namespace AS n
            ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (
              'productos',
              'lotes_productos',
              'compras_detalle',
              'ventas_detalle',
              'movimientos_inventario'
          )
          AND NOT t.tgisinternal
    ) AS triggers_inventario_omitidos;

-- 8. El trigger de Auth debe existir y estar habilitado.
WITH trigger_perfil AS (
    SELECT
        t.oid,
        t.tgenabled,
        p.proname,
        PG_GET_TRIGGERDEF(t.oid) AS definicion
    FROM pg_trigger AS t
    INNER JOIN pg_class AS c
        ON c.oid = t.tgrelid
    INNER JOIN pg_namespace AS n
        ON n.oid = c.relnamespace
    INNER JOIN pg_proc AS p
        ON p.oid = t.tgfoid
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND t.tgname = 'on_auth_user_created'
      AND NOT t.tgisinternal
)
SELECT
    EXISTS (SELECT 1 FROM trigger_perfil) AS existe,
    COALESCE(
        (SELECT tgenabled = 'O' FROM trigger_perfil LIMIT 1),
        FALSE
    ) AS habilitado,
    COALESCE(
        (
            SELECT definicion ILIKE '%AFTER INSERT ON auth.users%'
               AND definicion ILIKE '%FOR EACH ROW%'
               AND definicion ILIKE '%crear_perfil_usuario%'
            FROM trigger_perfil
            LIMIT 1
        ),
        FALSE
    ) AS definicion_correcta,
    (SELECT proname FROM trigger_perfil LIMIT 1) AS funcion,
    (SELECT definicion FROM trigger_perfil LIMIT 1) AS definicion;

-- 9. Cada referencia opcional de lote debe validar también el producto.
WITH restricciones_esperadas(nombre, tabla) AS (
    VALUES
        ('fk_compra_detalle_lote_producto', 'compras_detalle'),
        ('fk_venta_detalle_lote_producto', 'ventas_detalle'),
        ('fk_movimiento_lote_producto', 'movimientos_inventario')
)
SELECT
    e.tabla,
    e.nombre,
    c.oid IS NOT NULL AS existe,
    COALESCE(c.convalidated, FALSE) AS validada,
    COALESCE(
        (
            SELECT ARRAY_AGG(a.attname ORDER BY k.orden)
            FROM UNNEST(c.conkey) WITH ORDINALITY AS k(attnum, orden)
            INNER JOIN pg_attribute AS a
                ON a.attrelid = c.conrelid
               AND a.attnum = k.attnum
        ) = ARRAY['id_lote', 'id_producto']::NAME[]
        AND c.confrelid = 'public.lotes_productos'::REGCLASS
        AND (
            SELECT ARRAY_AGG(a.attname ORDER BY k.orden)
            FROM UNNEST(c.confkey) WITH ORDINALITY AS k(attnum, orden)
            INNER JOIN pg_attribute AS a
                ON a.attrelid = c.confrelid
               AND a.attnum = k.attnum
        ) = ARRAY['id_lote', 'id_producto']::NAME[],
        FALSE
    ) AS columnas_correctas,
    PG_GET_CONSTRAINTDEF(c.oid) AS definicion
FROM restricciones_esperadas AS e
LEFT JOIN pg_namespace AS n
    ON n.nspname = 'public'
LEFT JOIN pg_class AS t
    ON t.relnamespace = n.oid
   AND t.relname = e.tabla
LEFT JOIN pg_constraint AS c
    ON c.conrelid = t.oid
   AND c.conname = e.nombre
   AND c.contype = 'f'
ORDER BY e.tabla;

-- 10. Solo puede existir un proveedor principal por producto.
WITH indice AS (
    SELECT
        i.indisunique,
        i.indpred IS NOT NULL AS es_parcial,
        PG_GET_INDEXDEF(i.indexrelid) AS definicion,
        PG_GET_EXPR(i.indpred, i.indrelid) AS predicado
    FROM pg_index AS i
    WHERE i.indexrelid =
        TO_REGCLASS('public.uq_productos_proveedores_principal')
)
SELECT
    EXISTS (SELECT 1 FROM indice) AS existe,
    COALESCE((SELECT indisunique FROM indice), FALSE) AS es_unico,
    COALESCE((SELECT es_parcial FROM indice), FALSE) AS es_parcial,
    (SELECT predicado FROM indice) AS predicado,
    (SELECT definicion FROM indice) AS definicion;

-- 11. Privilegios predeterminados: las funciones futuras no recuperan
-- EXECUTE público y ningún rol API recibe grants predeterminados peligrosos.
WITH grants_predeterminados AS (
    SELECT
        d.defaclobjtype,
        d.defaclnamespace,
        COALESCE(grantee.rolname, 'PUBLIC') AS beneficiario,
        permiso.privilege_type
    FROM pg_default_acl AS d
    CROSS JOIN LATERAL ACLEXPLODE(d.defaclacl) AS permiso
    LEFT JOIN pg_roles AS grantee
        ON grantee.oid = permiso.grantee
    WHERE d.defaclrole = 'postgres'::REGROLE
)
SELECT
    EXISTS (
        SELECT 1
        FROM pg_default_acl AS d
        WHERE d.defaclrole = 'postgres'::REGROLE
          AND d.defaclobjtype = 'f'
          AND d.defaclnamespace = 0
    ) AS revocacion_global_funciones_registrada,
    NOT EXISTS (
        SELECT 1
        FROM grants_predeterminados AS g
        WHERE g.beneficiario IN (
            'PUBLIC',
            'anon',
            'authenticated',
            'service_role'
        )
          AND (
              (g.defaclobjtype = 'f' AND g.privilege_type = 'EXECUTE')
              OR g.defaclobjtype IN ('r', 'S')
          )
    ) AS sin_grants_predeterminados_peligrosos;

COMMIT;
