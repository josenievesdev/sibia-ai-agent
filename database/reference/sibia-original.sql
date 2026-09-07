-- ============================================================
-- SIBIA - BASE DE DATOS PARA TIENDA DE BARRIO
-- PostgreSQL / Supabase
-- ============================================================
--
-- Este script crea:
--   - Roles y perfiles de usuarios
--   - Clientes
--   - Categorías
--   - Productos
--   - Proveedores
--   - Relación productos/proveedores
--   - Lotes y vencimientos
--   - Compras
--   - Ventas
--   - Promociones
--   - Movimientos de inventario
--   - Auditoría de sesiones
--   - Vistas para consultas de SIBIA
--   - Funciones y triggers para inventario
--
-- IMPORTANTE:
-- Este script está diseñado para ejecutarse en SUPABASE.
-- NO crea una nueva base de datos porque Supabase ya proporciona
-- la base PostgreSQL.
--
-- ============================================================


-- ============================================================
-- 1. EXTENSIONES
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- 2. TABLA DE ROLES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.roles (
    id_rol UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre VARCHAR(30) NOT NULL UNIQUE,

    descripcion TEXT,

    CONSTRAINT chk_roles_nombre
        CHECK (nombre IN ('cliente', 'empleado', 'admin'))
);


-- ============================================================
-- 3. TABLA DE USUARIOS / PERFILES
-- ============================================================
--
-- En Supabase la autenticación real se maneja mediante
-- auth.users.
--
-- id_usuario corresponde al UUID del usuario autenticado
-- en Supabase Auth.
--
-- ============================================================

CREATE TABLE IF NOT EXISTS public.usuarios (
    id_usuario UUID PRIMARY KEY REFERENCES auth.users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    nombre_completo VARCHAR(150) NOT NULL,

    correo VARCHAR(255) NOT NULL UNIQUE,

    id_rol UUID NOT NULL,

    telefono VARCHAR(30),

    estado VARCHAR(20) NOT NULL DEFAULT 'activo',

    fecha_registro TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_usuarios_rol
        FOREIGN KEY (id_rol)
        REFERENCES public.roles(id_rol)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_usuarios_estado
        CHECK (estado IN ('activo', 'inactivo'))
);


-- ============================================================
-- 4. SESIONES Y AUDITORÍA
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sesiones_auditoria (
    id_sesion UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_usuario UUID NOT NULL,

    ip_origen INET,

    dispositivo VARCHAR(255),

    fecha_inicio TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    fecha_fin TIMESTAMPTZ,

    estado_sesion VARCHAR(20) NOT NULL DEFAULT 'activa',

    CONSTRAINT fk_sesiones_usuario
        FOREIGN KEY (id_usuario)
        REFERENCES public.usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_sesion_estado
        CHECK (estado_sesion IN ('activa', 'cerrada')),

    CONSTRAINT chk_sesion_fechas
        CHECK (
            fecha_fin IS NULL
            OR fecha_fin >= fecha_inicio
        )
);


-- ============================================================
-- 5. CLIENTES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.clientes (
    id_cliente UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre VARCHAR(150) NOT NULL,

    documento VARCHAR(30) UNIQUE,

    telefono VARCHAR(30),

    correo VARCHAR(255),

    direccion VARCHAR(255),

    fecha_registro TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    estado VARCHAR(20) NOT NULL DEFAULT 'activo',

    CONSTRAINT chk_clientes_estado
        CHECK (estado IN ('activo', 'inactivo'))
);


-- ============================================================
-- 6. CATEGORÍAS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.categorias (
    id_categoria UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre VARCHAR(100) NOT NULL UNIQUE,

    descripcion TEXT,

    estado VARCHAR(20) NOT NULL DEFAULT 'activo',

    CONSTRAINT chk_categorias_estado
        CHECK (estado IN ('activo', 'inactivo'))
);


-- ============================================================
-- 7. PRODUCTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.productos (
    id_producto UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    codigo_referencia VARCHAR(50) UNIQUE,

    nombre_producto VARCHAR(150) NOT NULL,

    descripcion TEXT,

    id_categoria UUID NOT NULL,

    unidad_medida VARCHAR(20) NOT NULL DEFAULT 'unidad',

    precio_venta NUMERIC(12,2) NOT NULL,

    precio_compra NUMERIC(12,2) NOT NULL DEFAULT 0,

    stock_actual NUMERIC(12,3) NOT NULL DEFAULT 0,

    stock_minimo NUMERIC(12,3) NOT NULL DEFAULT 0,

    estado VARCHAR(20) NOT NULL DEFAULT 'activo',

    fecha_registro TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_productos_categoria
        FOREIGN KEY (id_categoria)
        REFERENCES public.categorias(id_categoria)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_producto_precio_venta
        CHECK (precio_venta > 0),

    CONSTRAINT chk_producto_precio_compra
        CHECK (precio_compra >= 0),

    CONSTRAINT chk_producto_stock
        CHECK (stock_actual >= 0),

    CONSTRAINT chk_producto_stock_minimo
        CHECK (stock_minimo >= 0),

    CONSTRAINT chk_producto_unidad
        CHECK (
            unidad_medida IN (
                'unidad',
                'paquete',
                'botella',
                'lata',
                'bolsa',
                'caja',
                'gramo',
                'kilogramo',
                'mililitro',
                'litro'
            )
        ),

    CONSTRAINT chk_producto_estado
        CHECK (estado IN ('activo', 'inactivo'))
);


-- ============================================================
-- 8. PROVEEDORES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.proveedores (
    id_proveedor UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre VARCHAR(150) NOT NULL,

    nit VARCHAR(30) UNIQUE,

    telefono VARCHAR(30),

    correo VARCHAR(255),

    direccion VARCHAR(255),

    contacto VARCHAR(150),

    estado VARCHAR(20) NOT NULL DEFAULT 'activo',

    fecha_registro TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_proveedor_estado
        CHECK (estado IN ('activo', 'inactivo'))
);


-- ============================================================
-- 9. PRODUCTOS - PROVEEDORES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.productos_proveedores (
    id_producto UUID NOT NULL,

    id_proveedor UUID NOT NULL,

    codigo_proveedor VARCHAR(50),

    precio_compra_referencia NUMERIC(12,2) NOT NULL DEFAULT 0,

    es_principal BOOLEAN NOT NULL DEFAULT FALSE,

    PRIMARY KEY (id_producto, id_proveedor),

    CONSTRAINT fk_pp_producto
        FOREIGN KEY (id_producto)
        REFERENCES public.productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_pp_proveedor
        FOREIGN KEY (id_proveedor)
        REFERENCES public.proveedores(id_proveedor)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_pp_precio
        CHECK (precio_compra_referencia >= 0)
);


-- ============================================================
-- 10. LOTES Y VENCIMIENTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lotes_productos (
    id_lote UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_producto UUID NOT NULL,

    numero_lote VARCHAR(100),

    cantidad_inicial NUMERIC(12,3) NOT NULL DEFAULT 0,

    cantidad_actual NUMERIC(12,3) NOT NULL DEFAULT 0,

    fecha_ingreso TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    fecha_vencimiento DATE,

    CONSTRAINT fk_lote_producto
        FOREIGN KEY (id_producto)
        REFERENCES public.productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_lote_cantidad_inicial
        CHECK (cantidad_inicial >= 0),

    CONSTRAINT chk_lote_cantidad_actual
        CHECK (cantidad_actual >= 0),

    CONSTRAINT chk_lote_fecha_vencimiento
        CHECK (
            fecha_vencimiento IS NULL
            OR fecha_vencimiento >= fecha_ingreso::DATE
        ),

    CONSTRAINT uq_producto_lote
        UNIQUE (id_producto, numero_lote)
);


-- ============================================================
-- 11. COMPRAS - ENCABEZADO
-- ============================================================

CREATE TABLE IF NOT EXISTS public.compras_encabezado (
    id_compra UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_proveedor UUID NOT NULL,

    id_usuario UUID NOT NULL,

    fecha_compra TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,

    descuento NUMERIC(12,2) NOT NULL DEFAULT 0,

    total_compra NUMERIC(12,2) NOT NULL DEFAULT 0,

    observaciones TEXT,

    estado VARCHAR(20) NOT NULL DEFAULT 'registrada',

    CONSTRAINT fk_compra_proveedor
        FOREIGN KEY (id_proveedor)
        REFERENCES public.proveedores(id_proveedor)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_compra_usuario
        FOREIGN KEY (id_usuario)
        REFERENCES public.usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_compra_subtotal
        CHECK (subtotal >= 0),

    CONSTRAINT chk_compra_descuento
        CHECK (descuento >= 0),

    CONSTRAINT chk_compra_total
        CHECK (total_compra >= 0),

    CONSTRAINT chk_compra_estado
        CHECK (estado IN ('registrada', 'anulada'))
);


-- ============================================================
-- 12. COMPRAS - DETALLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.compras_detalle (
    id_detalle UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_compra UUID NOT NULL,

    id_producto UUID NOT NULL,

    id_lote UUID,

    cantidad NUMERIC(12,3) NOT NULL,

    precio_unitario NUMERIC(12,2) NOT NULL,

    subtotal NUMERIC(12,2) NOT NULL,

    CONSTRAINT fk_compra_detalle_compra
        FOREIGN KEY (id_compra)
        REFERENCES public.compras_encabezado(id_compra)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_compra_detalle_producto
        FOREIGN KEY (id_producto)
        REFERENCES public.productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_compra_detalle_lote
        FOREIGN KEY (id_lote)
        REFERENCES public.lotes_productos(id_lote)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_compra_detalle_cantidad
        CHECK (cantidad > 0),

    CONSTRAINT chk_compra_detalle_precio
        CHECK (precio_unitario >= 0),

    CONSTRAINT chk_compra_detalle_subtotal
        CHECK (subtotal >= 0)
);


-- ============================================================
-- 13. VENTAS - ENCABEZADO
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ventas_encabezado (
    id_venta UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_cliente UUID,

    id_empleado_vendedor UUID NOT NULL,

    fecha_venta TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,

    descuento NUMERIC(12,2) NOT NULL DEFAULT 0,

    total_venta NUMERIC(12,2) NOT NULL DEFAULT 0,

    metodo_pago VARCHAR(30) NOT NULL DEFAULT 'efectivo',

    estado VARCHAR(20) NOT NULL DEFAULT 'completada',

    CONSTRAINT fk_venta_cliente
        FOREIGN KEY (id_cliente)
        REFERENCES public.clientes(id_cliente)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    CONSTRAINT fk_venta_empleado
        FOREIGN KEY (id_empleado_vendedor)
        REFERENCES public.usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_venta_subtotal
        CHECK (subtotal >= 0),

    CONSTRAINT chk_venta_descuento
        CHECK (descuento >= 0),

    CONSTRAINT chk_venta_total
        CHECK (total_venta >= 0),

    CONSTRAINT chk_venta_metodo_pago
        CHECK (
            metodo_pago IN (
                'efectivo',
                'nequi',
                'daviplata',
                'transferencia',
                'tarjeta'
            )
        ),

    CONSTRAINT chk_venta_estado
        CHECK (estado IN ('completada', 'anulada'))
);


-- ============================================================
-- 14. VENTAS - DETALLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ventas_detalle (
    id_detalle UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_venta UUID NOT NULL,

    id_producto UUID NOT NULL,

    id_lote UUID,

    cantidad NUMERIC(12,3) NOT NULL,

    precio_unitario NUMERIC(12,2) NOT NULL,

    descuento NUMERIC(12,2) NOT NULL DEFAULT 0,

    subtotal NUMERIC(12,2) NOT NULL,

    CONSTRAINT fk_venta_detalle_venta
        FOREIGN KEY (id_venta)
        REFERENCES public.ventas_encabezado(id_venta)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_venta_detalle_producto
        FOREIGN KEY (id_producto)
        REFERENCES public.productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_venta_detalle_lote
        FOREIGN KEY (id_lote)
        REFERENCES public.lotes_productos(id_lote)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_venta_detalle_cantidad
        CHECK (cantidad > 0),

    CONSTRAINT chk_venta_detalle_precio
        CHECK (precio_unitario > 0),

    CONSTRAINT chk_venta_detalle_descuento
        CHECK (descuento >= 0),

    CONSTRAINT chk_venta_detalle_subtotal
        CHECK (subtotal >= 0)
);


-- ============================================================
-- 15. PROMOCIONES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.promociones (
    id_promocion UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre VARCHAR(150) NOT NULL,

    descripcion TEXT,

    tipo_promocion VARCHAR(20) NOT NULL,

    valor_descuento NUMERIC(12,2) NOT NULL,

    fecha_inicio TIMESTAMPTZ NOT NULL,

    fecha_fin TIMESTAMPTZ NOT NULL,

    estado VARCHAR(20) NOT NULL DEFAULT 'activa',

    CONSTRAINT chk_promocion_tipo
        CHECK (
            tipo_promocion IN (
                'porcentaje',
                'valor_fijo'
            )
        ),

    CONSTRAINT chk_promocion_valor
        CHECK (valor_descuento > 0),

    CONSTRAINT chk_promocion_porcentaje
        CHECK (
            tipo_promocion <> 'porcentaje'
            OR valor_descuento <= 100
        ),

    CONSTRAINT chk_promocion_fechas
        CHECK (fecha_fin >= fecha_inicio),

    CONSTRAINT chk_promocion_estado
        CHECK (
            estado IN (
                'activa',
                'inactiva',
                'finalizada'
            )
        )
);


-- ============================================================
-- 16. PRODUCTOS - PROMOCIONES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.productos_promociones (
    id_producto UUID NOT NULL,

    id_promocion UUID NOT NULL,

    PRIMARY KEY (id_producto, id_promocion),

    CONSTRAINT fk_producto_promocion_producto
        FOREIGN KEY (id_producto)
        REFERENCES public.productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_producto_promocion_promocion
        FOREIGN KEY (id_promocion)
        REFERENCES public.promociones(id_promocion)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
);


-- ============================================================
-- 17. MOVIMIENTOS DE INVENTARIO
-- ============================================================

CREATE TABLE IF NOT EXISTS public.movimientos_inventario (
    id_movimiento UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    id_producto UUID NOT NULL,

    id_lote UUID,

    tipo_movimiento VARCHAR(20) NOT NULL,

    cantidad NUMERIC(12,3) NOT NULL,

    fecha_movimiento TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    id_usuario_responsable UUID NOT NULL,

    motivo VARCHAR(255),

    referencia VARCHAR(100),

    CONSTRAINT fk_movimiento_producto
        FOREIGN KEY (id_producto)
        REFERENCES public.productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_movimiento_lote
        FOREIGN KEY (id_lote)
        REFERENCES public.lotes_productos(id_lote)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_movimiento_usuario
        FOREIGN KEY (id_usuario_responsable)
        REFERENCES public.usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_movimiento_tipo
        CHECK (
            tipo_movimiento IN (
                'ENTRADA',
                'SALIDA',
                'AJUSTE'
            )
        ),

    CONSTRAINT chk_movimiento_cantidad
        CHECK (cantidad > 0)
);


-- ============================================================
-- 18. ÍNDICES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_productos_codigo
    ON public.productos(codigo_referencia);

CREATE INDEX IF NOT EXISTS idx_productos_nombre
    ON public.productos(nombre_producto);

CREATE INDEX IF NOT EXISTS idx_productos_categoria
    ON public.productos(id_categoria);

CREATE INDEX IF NOT EXISTS idx_productos_stock
    ON public.productos(stock_actual);

CREATE INDEX IF NOT EXISTS idx_productos_estado
    ON public.productos(estado);

CREATE INDEX IF NOT EXISTS idx_usuarios_correo
    ON public.usuarios(correo);

CREATE INDEX IF NOT EXISTS idx_usuarios_rol
    ON public.usuarios(id_rol);

CREATE INDEX IF NOT EXISTS idx_sesiones_usuario
    ON public.sesiones_auditoria(id_usuario);

CREATE INDEX IF NOT EXISTS idx_sesiones_fecha
    ON public.sesiones_auditoria(fecha_inicio);

CREATE INDEX IF NOT EXISTS idx_lotes_producto
    ON public.lotes_productos(id_producto);

CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento
    ON public.lotes_productos(fecha_vencimiento);

CREATE INDEX IF NOT EXISTS idx_ventas_fecha
    ON public.ventas_encabezado(fecha_venta);

CREATE INDEX IF NOT EXISTS idx_ventas_cliente
    ON public.ventas_encabezado(id_cliente);

CREATE INDEX IF NOT EXISTS idx_ventas_empleado
    ON public.ventas_encabezado(id_empleado_vendedor);

CREATE INDEX IF NOT EXISTS idx_ventas_detalle_producto
    ON public.ventas_detalle(id_producto);

CREATE INDEX IF NOT EXISTS idx_compras_fecha
    ON public.compras_encabezado(fecha_compra);

CREATE INDEX IF NOT EXISTS idx_compras_proveedor
    ON public.compras_encabezado(id_proveedor);

CREATE INDEX IF NOT EXISTS idx_movimientos_fecha
    ON public.movimientos_inventario(fecha_movimiento);

CREATE INDEX IF NOT EXISTS idx_movimientos_producto
    ON public.movimientos_inventario(id_producto);


-- ============================================================
-- 19. FUNCIÓN PARA ACTUALIZAR INVENTARIO
-- ============================================================
--
-- Esta función controla las entradas y salidas de inventario.
--
-- Se utiliza:
--
-- ENTRADA -> aumenta stock
-- SALIDA  -> disminuye stock
--
-- Para AJUSTE se recomienda realizar la corrección mediante
-- una función específica de ajuste.
--
-- ============================================================

CREATE OR REPLACE FUNCTION public.actualizar_stock(
    p_producto UUID,
    p_cantidad NUMERIC,
    p_tipo VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_stock_actual NUMERIC;
BEGIN

    SELECT stock_actual
    INTO v_stock_actual
    FROM public.productos
    WHERE id_producto = p_producto
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El producto % no existe.', p_producto;
    END IF;

    IF p_tipo = 'ENTRADA' THEN

        UPDATE public.productos
        SET stock_actual = stock_actual + p_cantidad
        WHERE id_producto = p_producto;

    ELSIF p_tipo = 'SALIDA' THEN

        IF v_stock_actual < p_cantidad THEN
            RAISE EXCEPTION
                'Stock insuficiente para el producto %. Stock disponible: %, solicitado: %',
                p_producto,
                v_stock_actual,
                p_cantidad;
        END IF;

        UPDATE public.productos
        SET stock_actual = stock_actual - p_cantidad
        WHERE id_producto = p_producto;

    ELSE

        RAISE EXCEPTION
            'Tipo de movimiento inválido: %',
            p_tipo;

    END IF;

END;
$$;


-- ============================================================
-- 20. FUNCIÓN PARA ACTUALIZAR LOTES
-- ============================================================

CREATE OR REPLACE FUNCTION public.actualizar_stock_lote(
    p_lote UUID,
    p_cantidad NUMERIC,
    p_tipo VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_cantidad_actual NUMERIC;
BEGIN

    IF p_lote IS NULL THEN
        RETURN;
    END IF;

    SELECT cantidad_actual
    INTO v_cantidad_actual
    FROM public.lotes_productos
    WHERE id_lote = p_lote
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El lote % no existe.', p_lote;
    END IF;

    IF p_tipo = 'ENTRADA' THEN

        UPDATE public.lotes_productos
        SET cantidad_actual = cantidad_actual + p_cantidad
        WHERE id_lote = p_lote;

    ELSIF p_tipo = 'SALIDA' THEN

        IF v_cantidad_actual < p_cantidad THEN
            RAISE EXCEPTION
                'Stock insuficiente en el lote %. Disponible: %, solicitado: %',
                p_lote,
                v_cantidad_actual,
                p_cantidad;
        END IF;

        UPDATE public.lotes_productos
        SET cantidad_actual = cantidad_actual - p_cantidad
        WHERE id_lote = p_lote;

    END IF;

END;
$$;


-- ============================================================
-- 21. FUNCIÓN PARA REGISTRAR MOVIMIENTO DE INVENTARIO
-- ============================================================

CREATE OR REPLACE FUNCTION public.registrar_movimiento_inventario(
    p_producto UUID,
    p_lote UUID,
    p_tipo VARCHAR,
    p_cantidad NUMERIC,
    p_usuario UUID,
    p_motivo VARCHAR,
    p_referencia VARCHAR
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id_movimiento UUID;
BEGIN

    INSERT INTO public.movimientos_inventario (
        id_producto,
        id_lote,
        tipo_movimiento,
        cantidad,
        id_usuario_responsable,
        motivo,
        referencia
    )
    VALUES (
        p_producto,
        p_lote,
        p_tipo,
        p_cantidad,
        p_usuario,
        p_motivo,
        p_referencia
    )
    RETURNING id_movimiento INTO v_id_movimiento;

    RETURN v_id_movimiento;

END;
$$;


-- ============================================================
-- 22. FUNCIÓN PARA PROCESAR DETALLE DE COMPRA
-- ============================================================

CREATE OR REPLACE FUNCTION public.procesar_compra_detalle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_usuario UUID;
BEGIN

    SELECT id_usuario
    INTO v_usuario
    FROM public.compras_encabezado
    WHERE id_compra = NEW.id_compra;

    -- Actualizar inventario general
    PERFORM public.actualizar_stock(
        NEW.id_producto,
        NEW.cantidad,
        'ENTRADA'
    );

    -- Actualizar lote si existe
    IF NEW.id_lote IS NOT NULL THEN

        PERFORM public.actualizar_stock_lote(
            NEW.id_lote,
            NEW.cantidad,
            'ENTRADA'
        );

    END IF;

    -- Registrar movimiento
    PERFORM public.registrar_movimiento_inventario(
        NEW.id_producto,
        NEW.id_lote,
        'ENTRADA',
        NEW.cantidad,
        v_usuario,
        'Entrada por compra',
        NEW.id_compra::TEXT
    );

    RETURN NEW;

END;
$$;


CREATE OR REPLACE TRIGGER trg_procesar_compra_detalle
AFTER INSERT ON public.compras_detalle
FOR EACH ROW
EXECUTE FUNCTION public.procesar_compra_detalle();


-- ============================================================
-- 23. FUNCIÓN PARA PROCESAR DETALLE DE VENTA
-- ============================================================

CREATE OR REPLACE FUNCTION public.procesar_venta_detalle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_usuario UUID;
BEGIN

    SELECT id_empleado_vendedor
    INTO v_usuario
    FROM public.ventas_encabezado
    WHERE id_venta = NEW.id_venta;

    -- Actualizar inventario general
    PERFORM public.actualizar_stock(
        NEW.id_producto,
        NEW.cantidad,
        'SALIDA'
    );

    -- Actualizar lote si existe
    IF NEW.id_lote IS NOT NULL THEN

        PERFORM public.actualizar_stock_lote(
            NEW.id_lote,
            NEW.cantidad,
            'SALIDA'
        );

    END IF;

    -- Registrar movimiento
    PERFORM public.registrar_movimiento_inventario(
        NEW.id_producto,
        NEW.id_lote,
        'SALIDA',
        NEW.cantidad,
        v_usuario,
        'Salida por venta',
        NEW.id_venta::TEXT
    );

    RETURN NEW;

END;
$$;


CREATE OR REPLACE TRIGGER trg_procesar_venta_detalle
AFTER INSERT ON public.ventas_detalle
FOR EACH ROW
EXECUTE FUNCTION public.procesar_venta_detalle();


-- ============================================================
-- 24. VISTA GENERAL DEL INVENTARIO
-- ============================================================

CREATE OR REPLACE VIEW public.vista_inventario AS
SELECT
    p.id_producto,
    p.codigo_referencia,
    p.nombre_producto,
    c.nombre AS categoria,
    p.unidad_medida,
    p.precio_compra,
    p.precio_venta,
    p.stock_actual,
    p.stock_minimo,
    p.estado,

    CASE
        WHEN p.stock_actual <= p.stock_minimo
        THEN TRUE
        ELSE FALSE
    END AS stock_bajo

FROM public.productos p
INNER JOIN public.categorias c
    ON c.id_categoria = p.id_categoria;


-- ============================================================
-- 25. VISTA DE PRODUCTOS CON STOCK BAJO
-- ============================================================

CREATE OR REPLACE VIEW public.vista_productos_stock_bajo AS
SELECT
    p.id_producto,
    p.codigo_referencia,
    p.nombre_producto,
    c.nombre AS categoria,
    p.unidad_medida,
    p.stock_actual,
    p.stock_minimo,
    p.precio_venta

FROM public.productos p

INNER JOIN public.categorias c
    ON c.id_categoria = p.id_categoria

WHERE p.stock_actual <= p.stock_minimo
  AND p.estado = 'activo';


-- ============================================================
-- 26. VISTA DE PRODUCTOS PRÓXIMOS A VENCER
-- ============================================================

CREATE OR REPLACE VIEW public.vista_productos_por_vencer AS
SELECT
    l.id_lote,
    p.id_producto,
    p.codigo_referencia,
    p.nombre_producto,
    c.nombre AS categoria,
    l.numero_lote,
    l.cantidad_actual,
    l.fecha_ingreso,
    l.fecha_vencimiento,

    (l.fecha_vencimiento - CURRENT_DATE) AS dias_para_vencer

FROM public.lotes_productos l

INNER JOIN public.productos p
    ON p.id_producto = l.id_producto

INNER JOIN public.categorias c
    ON c.id_categoria = p.id_categoria

WHERE l.fecha_vencimiento IS NOT NULL
  AND l.fecha_vencimiento >= CURRENT_DATE
  AND l.fecha_vencimiento <= CURRENT_DATE + INTERVAL '30 days'
  AND l.cantidad_actual > 0;


-- ============================================================
-- 27. VISTA DE PROMOCIONES ACTIVAS
-- ============================================================

CREATE OR REPLACE VIEW public.vista_promociones_activas AS
SELECT
    pr.id_promocion,
    pr.nombre AS promocion,
    pr.descripcion,
    pr.tipo_promocion,
    pr.valor_descuento,
    pr.fecha_inicio,
    pr.fecha_fin,
    p.id_producto,
    p.codigo_referencia,
    p.nombre_producto,
    p.precio_venta

FROM public.promociones pr

INNER JOIN public.productos_promociones pp
    ON pp.id_promocion = pr.id_promocion

INNER JOIN public.productos p
    ON p.id_producto = pp.id_producto

WHERE pr.estado = 'activa'
  AND CURRENT_TIMESTAMP BETWEEN pr.fecha_inicio AND pr.fecha_fin
  AND p.estado = 'activo';


-- ============================================================
-- 28. VISTA DE RESUMEN DE VENTAS
-- ============================================================

CREATE OR REPLACE VIEW public.vista_ventas_resumen AS
SELECT
    v.id_venta,
    v.fecha_venta,

    c.nombre AS cliente,

    u.nombre_completo AS vendedor,

    v.metodo_pago,

    v.subtotal,
    v.descuento,
    v.total_venta,
    v.estado

FROM public.ventas_encabezado v

LEFT JOIN public.clientes c
    ON c.id_cliente = v.id_cliente

INNER JOIN public.usuarios u
    ON u.id_usuario = v.id_empleado_vendedor;


-- ============================================================
-- 29. FUNCIÓN PARA CREAR PERFIL DE USUARIO AUTOMÁTICAMENTE
-- ============================================================
--
-- Cuando un usuario se registra mediante Supabase Auth,
-- esta función puede crear automáticamente su perfil.
--
-- El usuario se crea inicialmente como cliente.
--
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_perfil_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rol_cliente UUID;
BEGIN

    SELECT id_rol
    INTO v_rol_cliente
    FROM public.roles
    WHERE nombre = 'cliente';

    INSERT INTO public.usuarios (
        id_usuario,
        nombre_completo,
        correo,
        id_rol
    )
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data ->> 'nombre_completo',
            NEW.email
        ),
        NEW.email,
        v_rol_cliente
    );

    RETURN NEW;

END;
$$;


-- ============================================================
-- 30. TRIGGER DE PERFIL DE USUARIO
-- ============================================================

DROP TRIGGER IF EXISTS on_auth_user_created
ON auth.users;

CREATE TRIGGER on_auth_user_created

AFTER INSERT ON auth.users

FOR EACH ROW

EXECUTE FUNCTION public.crear_perfil_usuario();


-- ============================================================
-- 31. DATOS SEMILLA - ROLES
-- ============================================================

INSERT INTO public.roles (
    nombre,
    descripcion
)
VALUES
(
    'cliente',
    'Cliente de la tienda'
),
(
    'empleado',
    'Empleado encargado de operaciones de la tienda'
),
(
    'admin',
    'Administrador del sistema'
)

ON CONFLICT (nombre)
DO NOTHING;


-- ============================================================
-- 32. DATOS SEMILLA - CATEGORÍAS
-- ============================================================

INSERT INTO public.categorias (
    nombre,
    descripcion
)
VALUES
(
    'Bebidas',
    'Gaseosas, aguas, jugos y otras bebidas'
),
(
    'Abarrotes',
    'Productos básicos de mercado'
),
(
    'Snacks y Confitería',
    'Papas, galletas, chocolates y dulces'
),
(
    'Lácteos',
    'Leche, yogur y productos derivados'
),
(
    'Aseo',
    'Productos de limpieza y aseo'
),
(
    'Hogar',
    'Productos básicos para el hogar'
),
(
    'Cuidado Personal',
    'Productos de higiene y cuidado personal'
),
(
    'Panadería',
    'Pan y productos de panadería'
)

ON CONFLICT (nombre)
DO NOTHING;


-- ============================================================
-- 33. DATOS SEMILLA - PROVEEDORES
-- ============================================================

INSERT INTO public.proveedores (
    nombre,
    nit,
    telefono,
    correo,
    direccion,
    contacto
)
VALUES
(
    'Distribuciones La 30',
    '900000001-1',
    '3001112233',
    'contacto@distribucionesla30.test',
    'Carrera 30 # 10-20',
    'Carlos Rodríguez'
),
(
    'Comercializadora El Ahorro',
    '900000002-2',
    '3012223344',
    'ventas@elahorro.test',
    'Calle 20 # 15-30',
    'María Gómez'
),
(
    'Mayorista del Barrio',
    '900000003-3',
    '3023334455',
    'pedidos@mayoristadelbarrio.test',
    'Carrera 12 # 25-40',
    'Andrés Martínez'
),
(
    'Distribuciones Andinas',
    '900000004-4',
    '3034445566',
    'ventas@distribucionesandinas.test',
    'Calle 45 # 20-10',
    'Laura Pérez'
)

ON CONFLICT (nit)
DO NOTHING;


-- ============================================================
-- 34. PRODUCTOS DE PRUEBA
-- ============================================================

INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'BEB-001',
    'Gaseosa Cola 1.5L',
    'Gaseosa sabor cola presentación 1.5 litros',
    id_categoria,
    'botella',
    7000,
    4500,
    30,
    10
FROM public.categorias
WHERE nombre = 'Bebidas'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'BEB-002',
    'Agua 600ml',
    'Agua embotellada de 600ml',
    id_categoria,
    'botella',
    3000,
    1800,
    50,
    15
FROM public.categorias
WHERE nombre = 'Bebidas'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'ABA-001',
    'Arroz Blanco 1kg',
    'Arroz blanco presentación de 1 kilogramo',
    id_categoria,
    'kilogramo',
    4500,
    3200,
    25,
    8
FROM public.categorias
WHERE nombre = 'Abarrotes'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'ABA-002',
    'Aceite Vegetal 1L',
    'Aceite vegetal de cocina',
    id_categoria,
    'litro',
    8500,
    6500,
    20,
    6
FROM public.categorias
WHERE nombre = 'Abarrotes'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'SNK-001',
    'Papas de Paquete',
    'Papas fritas de paquete',
    id_categoria,
    'bolsa',
    2500,
    1500,
    40,
    10
FROM public.categorias
WHERE nombre = 'Snacks y Confitería'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'SNK-002',
    'Galletas de Chocolate',
    'Galletas con sabor a chocolate',
    id_categoria,
    'paquete',
    3000,
    1800,
    35,
    10
FROM public.categorias
WHERE nombre = 'Snacks y Confitería'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'LAC-001',
    'Leche Entera 1L',
    'Leche entera larga vida',
    id_categoria,
    'litro',
    4500,
    3300,
    20,
    8
FROM public.categorias
WHERE nombre = 'Lácteos'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'LAC-002',
    'Yogur Natural',
    'Yogur natural individual',
    id_categoria,
    'unidad',
    2500,
    1600,
    15,
    5
FROM public.categorias
WHERE nombre = 'Lácteos'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'ASE-001',
    'Jabón de Ropa',
    'Jabón para lavar ropa',
    id_categoria,
    'unidad',
    3500,
    2200,
    18,
    5
FROM public.categorias
WHERE nombre = 'Aseo'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'HOG-001',
    'Papel Higiénico',
    'Papel higiénico de uso doméstico',
    id_categoria,
    'paquete',
    7000,
    4800,
    15,
    5
FROM public.categorias
WHERE nombre = 'Hogar'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'PAN-001',
    'Pan Tajado',
    'Pan tajado empacado',
    id_categoria,
    'paquete',
    6500,
    4500,
    10,
    4
FROM public.categorias
WHERE nombre = 'Panadería'

ON CONFLICT (codigo_referencia)
DO NOTHING;


INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
)

SELECT
    'BEB-003',
    'Jugo en Caja',
    'Jugo de fruta en caja individual',
    id_categoria,
    'unidad',
    2500,
    1500,
    25,
    8
FROM public.categorias
WHERE nombre = 'Bebidas'

ON CONFLICT (codigo_referencia)
DO NOTHING;


-- ============================================================
-- 35. CLIENTES DE PRUEBA
-- ============================================================

INSERT INTO public.clientes (
    nombre,
    documento,
    telefono
)
VALUES
(
    'Juan Pérez',
    '100000001',
    '3101112233'
),
(
    'María Rodríguez',
    '100000002',
    '3112223344'
),
(
    'Carlos Gómez',
    '100000003',
    '3123334455'
)

ON CONFLICT (documento)
DO NOTHING;


-- ============================================================
-- 36. RELACIÓN PRODUCTOS - PROVEEDORES
-- ============================================================

INSERT INTO public.productos_proveedores (
    id_producto,
    id_proveedor,
    precio_compra_referencia,
    es_principal
)

SELECT
    p.id_producto,
    pr.id_proveedor,
    p.precio_compra,
    TRUE

FROM public.productos p

CROSS JOIN LATERAL (
    SELECT id_proveedor
    FROM public.proveedores
    ORDER BY nombre
    LIMIT 1
) pr

ON CONFLICT (id_producto, id_proveedor)
DO NOTHING;


-- ============================================================
-- 37. LOTES DE PRUEBA
-- ============================================================

INSERT INTO public.lotes_productos (
    id_producto,
    numero_lote,
    cantidad_inicial,
    cantidad_actual,
    fecha_ingreso,
    fecha_vencimiento
)

SELECT
    id_producto,
    'LOTE-LECHE-001',
    20,
    20,
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '45 days'
FROM public.productos
WHERE codigo_referencia = 'LAC-001'

ON CONFLICT (id_producto, numero_lote)
DO NOTHING;


INSERT INTO public.lotes_productos (
    id_producto,
    numero_lote,
    cantidad_inicial,
    cantidad_actual,
    fecha_ingreso,
    fecha_vencimiento
)

SELECT
    id_producto,
    'LOTE-YOGUR-001',
    15,
    15,
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '20 days'
FROM public.productos
WHERE codigo_referencia = 'LAC-002'

ON CONFLICT (id_producto, numero_lote)
DO NOTHING;


INSERT INTO public.lotes_productos (
    id_producto,
    numero_lote,
    cantidad_inicial,
    cantidad_actual,
    fecha_ingreso,
    fecha_vencimiento
)

SELECT
    id_producto,
    'LOTE-GALLETAS-001',
    35,
    35,
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '120 days'
FROM public.productos
WHERE codigo_referencia = 'SNK-002'

ON CONFLICT (id_producto, numero_lote)
DO NOTHING;


-- ============================================================
-- 38. PROMOCIONES DE PRUEBA
-- ============================================================

INSERT INTO public.promociones (
    nombre,
    descripcion,
    tipo_promocion,
    valor_descuento,
    fecha_inicio,
    fecha_fin
)
VALUES
(
    'Descuento en bebidas',
    'Descuento especial en bebidas seleccionadas',
    'porcentaje',
    10,
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '30 days'
),
(
    'Oferta de galletas',
    'Descuento especial en galletas',
    'valor_fijo',
    500,
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '20 days'
),
(
    'Promoción lácteos',
    'Oferta especial en productos lácteos',
    'porcentaje',
    15,
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '15 days'
);


-- ============================================================
-- 39. ASOCIAR PROMOCIONES A PRODUCTOS
-- ============================================================

INSERT INTO public.productos_promociones (
    id_producto,
    id_promocion
)

SELECT
    p.id_producto,
    pr.id_promocion

FROM public.productos p

CROSS JOIN public.promociones pr

WHERE p.codigo_referencia = 'BEB-001'
  AND pr.nombre = 'Descuento en bebidas'

ON CONFLICT DO NOTHING;


INSERT INTO public.productos_promociones (
    id_producto,
    id_promocion
)

SELECT
    p.id_producto,
    pr.id_promocion

FROM public.productos p

CROSS JOIN public.promociones pr

WHERE p.codigo_referencia = 'SNK-002'
  AND pr.nombre = 'Oferta de galletas'

ON CONFLICT DO NOTHING;


INSERT INTO public.productos_promociones (
    id_producto,
    id_promocion
)

SELECT
    p.id_producto,
    pr.id_promocion

FROM public.productos p

CROSS JOIN public.promociones pr

WHERE p.codigo_referencia = 'LAC-001'
  AND pr.nombre = 'Promoción lácteos'

ON CONFLICT DO NOTHING;


-- ============================================================
-- 40. COMENTARIOS SOBRE LAS TABLAS
-- ============================================================

COMMENT ON TABLE public.roles IS
'Roles de acceso de SIBIA.';

COMMENT ON TABLE public.usuarios IS
'Perfil de usuarios autenticados mediante Supabase Auth.';

COMMENT ON TABLE public.clientes IS
'Clientes de la tienda. No requieren necesariamente una cuenta de usuario.';

COMMENT ON TABLE public.productos IS
'Catálogo principal de productos de la tienda.';

COMMENT ON TABLE public.proveedores IS
'Proveedores que suministran productos a la tienda.';

COMMENT ON TABLE public.lotes_productos IS
'Lotes de productos que requieren control de vencimiento.';

COMMENT ON TABLE public.compras_encabezado IS
'Registro principal de compras realizadas a proveedores.';

COMMENT ON TABLE public.ventas_encabezado IS
'Registro principal de ventas realizadas en la tienda.';

COMMENT ON TABLE public.movimientos_inventario IS
'Historial de entradas y salidas de inventario.';


-- ============================================================
-- 41. CONSULTAS DE PRUEBA
-- ============================================================

-- Ver todos los productos
-- SELECT * FROM public.vista_inventario;

-- Ver productos con stock bajo
-- SELECT * FROM public.vista_productos_stock_bajo;

-- Ver productos próximos a vencer
-- SELECT * FROM public.vista_productos_por_vencer;

-- Ver promociones activas
-- SELECT * FROM public.vista_promociones_activas;

-- Ver resumen de ventas
-- SELECT * FROM public.vista_ventas_resumen;

-- Ver movimientos de inventario
-- SELECT *
-- FROM public.movimientos_inventario
-- ORDER BY fecha_movimiento DESC;


-- ============================================================
-- FIN DEL SCRIPT SIBIA
-- ============================================================
