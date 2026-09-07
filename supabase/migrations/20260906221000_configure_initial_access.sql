-- SIBIA: roles obligatorios y acceso interno inicial.
-- Política temporal conservadora:
--   anon, cliente y empleado: sin datos de negocio.
--   admin activo y autenticado: solo SELECT.
-- Ningún rol de API recibe escritura ni acceso a funciones mutadoras.

BEGIN;

-- Estos roles son datos de referencia requeridos por el trigger de Auth.
INSERT INTO public.roles (nombre, descripcion)
VALUES
    ('cliente', 'Cliente de la tienda'),
    ('empleado', 'Empleado encargado de operaciones de la tienda'),
    ('admin', 'Administrador del sistema')
ON CONFLICT (nombre)
DO UPDATE SET descripcion = EXCLUDED.descripcion;

CREATE SCHEMA IF NOT EXISTS private;
ALTER SCHEMA private OWNER TO postgres;

REVOKE ALL ON SCHEMA private
    FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated;

REVOKE CREATE ON SCHEMA public
    FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- La función evita consultar public.usuarios desde su propia política RLS.
-- No recibe UUID ajeno: solo evalúa al usuario autenticado de la solicitud.
CREATE FUNCTION private.es_admin_activo()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.usuarios AS u
        INNER JOIN public.roles AS r
            ON r.id_rol = u.id_rol
        WHERE u.id_usuario = auth.uid()
          AND u.estado = 'activo'
          AND r.nombre = 'admin'
    );
$$;

ALTER FUNCTION private.es_admin_activo() OWNER TO postgres;

COMMENT ON FUNCTION private.es_admin_activo() IS
    'Comprueba si auth.uid() tiene un perfil activo con rol de negocio admin.';

REVOKE ALL ON FUNCTION private.es_admin_activo()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.es_admin_activo()
    TO authenticated;

-- El alta de Auth siempre crea un perfil cliente. El ascenso a admin es una
-- operación administrativa posterior y explícita basada en el UUID de Auth.
CREATE FUNCTION public.crear_perfil_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rol_cliente UUID;
    v_nombre_completo TEXT;
BEGIN
    IF NEW.email IS NULL OR BTRIM(NEW.email) = '' THEN
        RAISE EXCEPTION
            'SIBIA requiere un correo en Supabase Auth para crear el perfil.';
    END IF;

    SELECT r.id_rol
    INTO v_rol_cliente
    FROM public.roles AS r
    WHERE r.nombre = 'cliente';

    IF v_rol_cliente IS NULL THEN
        RAISE EXCEPTION
            'No existe el rol obligatorio cliente para crear el perfil SIBIA.';
    END IF;

    v_nombre_completo := COALESCE(
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'nombre_completo'), ''),
        NEW.email
    );

    INSERT INTO public.usuarios (
        id_usuario,
        nombre_completo,
        correo,
        id_rol
    )
    VALUES (
        NEW.id,
        LEFT(v_nombre_completo, 150),
        LEFT(NEW.email, 255),
        v_rol_cliente
    );

    RETURN NEW;
END;
$$;

ALTER FUNCTION public.crear_perfil_usuario() OWNER TO postgres;

COMMENT ON FUNCTION public.crear_perfil_usuario() IS
    'Trigger de Auth: crea un perfil de SIBIA con rol cliente.';

REVOKE ALL ON FUNCTION public.crear_perfil_usuario()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.crear_perfil_usuario();

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sesiones_auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos_proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotes_productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras_encabezado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras_detalle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas_encabezado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas_detalle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promociones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos_promociones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_inventario ENABLE ROW LEVEL SECURITY;

-- El rol PostgreSQL authenticated necesita SELECT para que RLS pueda decidir.
-- No se concede INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ni TRIGGER.
REVOKE ALL PRIVILEGES ON TABLE
    public.roles,
    public.usuarios,
    public.sesiones_auditoria,
    public.clientes,
    public.categorias,
    public.productos,
    public.proveedores,
    public.productos_proveedores,
    public.lotes_productos,
    public.compras_encabezado,
    public.compras_detalle,
    public.ventas_encabezado,
    public.ventas_detalle,
    public.promociones,
    public.productos_promociones,
    public.movimientos_inventario
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
    public.roles,
    public.usuarios,
    public.sesiones_auditoria,
    public.clientes,
    public.categorias,
    public.productos,
    public.proveedores,
    public.productos_proveedores,
    public.lotes_productos,
    public.compras_encabezado,
    public.compras_detalle,
    public.ventas_encabezado,
    public.ventas_detalle,
    public.promociones,
    public.productos_promociones,
    public.movimientos_inventario
TO authenticated;

REVOKE ALL PRIVILEGES ON TABLE
    public.vista_inventario,
    public.vista_productos_stock_bajo,
    public.vista_productos_por_vencer,
    public.vista_promociones_activas,
    public.vista_ventas_resumen
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
    public.vista_inventario,
    public.vista_productos_stock_bajo,
    public.vista_productos_por_vencer,
    public.vista_promociones_activas,
    public.vista_ventas_resumen
TO authenticated;

CREATE POLICY admin_activo_select_roles
ON public.roles
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_usuarios
ON public.usuarios
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_sesiones_auditoria
ON public.sesiones_auditoria
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_clientes
ON public.clientes
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_categorias
ON public.categorias
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_productos
ON public.productos
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_proveedores
ON public.proveedores
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_productos_proveedores
ON public.productos_proveedores
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_lotes_productos
ON public.lotes_productos
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_compras_encabezado
ON public.compras_encabezado
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_compras_detalle
ON public.compras_detalle
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_ventas_encabezado
ON public.ventas_encabezado
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_ventas_detalle
ON public.ventas_detalle
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_promociones
ON public.promociones
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_productos_promociones
ON public.productos_promociones
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

CREATE POLICY admin_activo_select_movimientos_inventario
ON public.movimientos_inventario
FOR SELECT
TO authenticated
USING ((SELECT private.es_admin_activo()));

-- Evita que objetos futuros recuperen privilegios amplios por defecto cuando
-- las migraciones se ejecuten con el rol postgres de Supabase.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
