-- SIBIA: estructura base de la tienda.
-- Destino: proyecto Supabase vacío.
-- Este archivo no carga datos ni habilita escrituras para la API.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.roles (
    id_rol UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(30) NOT NULL UNIQUE,
    descripcion TEXT,
    CONSTRAINT chk_roles_nombre
        CHECK (nombre IN ('cliente', 'empleado', 'admin'))
);

CREATE TABLE public.usuarios (
    id_usuario UUID PRIMARY KEY
        REFERENCES auth.users(id)
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

CREATE TABLE public.sesiones_auditoria (
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
        CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

CREATE TABLE public.clientes (
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

CREATE TABLE public.categorias (
    id_categoria UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT,
    estado VARCHAR(20) NOT NULL DEFAULT 'activo',
    CONSTRAINT chk_categorias_estado
        CHECK (estado IN ('activo', 'inactivo'))
);

CREATE TABLE public.productos (
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

CREATE TABLE public.proveedores (
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

CREATE TABLE public.productos_proveedores (
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

CREATE UNIQUE INDEX uq_productos_proveedores_principal
    ON public.productos_proveedores(id_producto)
    WHERE es_principal;

CREATE TABLE public.lotes_productos (
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
        UNIQUE (id_producto, numero_lote),
    CONSTRAINT uq_lote_producto_identidad
        UNIQUE (id_lote, id_producto)
);

CREATE TABLE public.compras_encabezado (
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

CREATE TABLE public.compras_detalle (
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
    CONSTRAINT fk_compra_detalle_lote_producto
        FOREIGN KEY (id_lote, id_producto)
        REFERENCES public.lotes_productos(id_lote, id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT chk_compra_detalle_cantidad
        CHECK (cantidad > 0),
    CONSTRAINT chk_compra_detalle_precio
        CHECK (precio_unitario >= 0),
    CONSTRAINT chk_compra_detalle_subtotal
        CHECK (subtotal >= 0)
);

CREATE TABLE public.ventas_encabezado (
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

CREATE TABLE public.ventas_detalle (
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
    CONSTRAINT fk_venta_detalle_lote_producto
        FOREIGN KEY (id_lote, id_producto)
        REFERENCES public.lotes_productos(id_lote, id_producto)
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

CREATE TABLE public.promociones (
    id_promocion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(150) NOT NULL,
    descripcion TEXT,
    tipo_promocion VARCHAR(20) NOT NULL,
    valor_descuento NUMERIC(12,2) NOT NULL,
    fecha_inicio TIMESTAMPTZ NOT NULL,
    fecha_fin TIMESTAMPTZ NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'activa',
    CONSTRAINT chk_promocion_tipo
        CHECK (tipo_promocion IN ('porcentaje', 'valor_fijo')),
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
        CHECK (estado IN ('activa', 'inactiva', 'finalizada'))
);

CREATE TABLE public.productos_promociones (
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

CREATE TABLE public.movimientos_inventario (
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
    CONSTRAINT fk_movimiento_lote_producto
        FOREIGN KEY (id_lote, id_producto)
        REFERENCES public.lotes_productos(id_lote, id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT fk_movimiento_usuario
        FOREIGN KEY (id_usuario_responsable)
        REFERENCES public.usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT chk_movimiento_tipo
        CHECK (tipo_movimiento IN ('ENTRADA', 'SALIDA', 'AJUSTE')),
    CONSTRAINT chk_movimiento_cantidad
        CHECK (cantidad > 0)
);

-- Índices originales no redundantes. Los índices adicionales se decidirán
-- después de medir las consultas reales de las tools.
CREATE INDEX idx_productos_nombre
    ON public.productos(nombre_producto);
CREATE INDEX idx_productos_categoria
    ON public.productos(id_categoria);
CREATE INDEX idx_productos_stock
    ON public.productos(stock_actual);
CREATE INDEX idx_productos_estado
    ON public.productos(estado);
CREATE INDEX idx_usuarios_rol
    ON public.usuarios(id_rol);
CREATE INDEX idx_sesiones_usuario
    ON public.sesiones_auditoria(id_usuario);
CREATE INDEX idx_sesiones_fecha
    ON public.sesiones_auditoria(fecha_inicio);
CREATE INDEX idx_lotes_producto
    ON public.lotes_productos(id_producto);
CREATE INDEX idx_lotes_vencimiento
    ON public.lotes_productos(fecha_vencimiento);
CREATE INDEX idx_compras_fecha
    ON public.compras_encabezado(fecha_compra);
CREATE INDEX idx_compras_proveedor
    ON public.compras_encabezado(id_proveedor);
CREATE INDEX idx_ventas_fecha
    ON public.ventas_encabezado(fecha_venta);
CREATE INDEX idx_ventas_cliente
    ON public.ventas_encabezado(id_cliente);
CREATE INDEX idx_ventas_empleado
    ON public.ventas_encabezado(id_empleado_vendedor);
CREATE INDEX idx_ventas_detalle_producto
    ON public.ventas_detalle(id_producto);
CREATE INDEX idx_movimientos_fecha
    ON public.movimientos_inventario(fecha_movimiento);
CREATE INDEX idx_movimientos_producto
    ON public.movimientos_inventario(id_producto);

CREATE VIEW public.vista_inventario
WITH (security_invoker = true)
AS
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
    (p.stock_actual <= p.stock_minimo) AS stock_bajo
FROM public.productos AS p
INNER JOIN public.categorias AS c
    ON c.id_categoria = p.id_categoria;

CREATE VIEW public.vista_productos_stock_bajo
WITH (security_invoker = true)
AS
SELECT
    p.id_producto,
    p.codigo_referencia,
    p.nombre_producto,
    c.nombre AS categoria,
    p.unidad_medida,
    p.stock_actual,
    p.stock_minimo,
    p.precio_venta
FROM public.productos AS p
INNER JOIN public.categorias AS c
    ON c.id_categoria = p.id_categoria
WHERE p.stock_actual <= p.stock_minimo
  AND p.estado = 'activo';

CREATE VIEW public.vista_productos_por_vencer
WITH (security_invoker = true)
AS
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
FROM public.lotes_productos AS l
INNER JOIN public.productos AS p
    ON p.id_producto = l.id_producto
INNER JOIN public.categorias AS c
    ON c.id_categoria = p.id_categoria
WHERE l.fecha_vencimiento IS NOT NULL
  AND l.fecha_vencimiento >= CURRENT_DATE
  AND l.fecha_vencimiento <= CURRENT_DATE + 30
  AND l.cantidad_actual > 0;

CREATE VIEW public.vista_promociones_activas
WITH (security_invoker = true)
AS
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
FROM public.promociones AS pr
INNER JOIN public.productos_promociones AS pp
    ON pp.id_promocion = pr.id_promocion
INNER JOIN public.productos AS p
    ON p.id_producto = pp.id_producto
WHERE pr.estado = 'activa'
  AND CURRENT_TIMESTAMP BETWEEN pr.fecha_inicio AND pr.fecha_fin
  AND p.estado = 'activo';

CREATE VIEW public.vista_ventas_resumen
WITH (security_invoker = true)
AS
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
FROM public.ventas_encabezado AS v
LEFT JOIN public.clientes AS c
    ON c.id_cliente = v.id_cliente
INNER JOIN public.usuarios AS u
    ON u.id_usuario = v.id_empleado_vendedor;

COMMENT ON TABLE public.roles IS
    'Roles de negocio de SIBIA; no sustituyen los roles PostgreSQL ni RLS.';
COMMENT ON TABLE public.usuarios IS
    'Perfiles vinculados a Supabase Auth.';
COMMENT ON TABLE public.sesiones_auditoria IS
    'Auditoría de sesiones; su captura y retención aún deben definirse.';
COMMENT ON TABLE public.clientes IS
    'Clientes comerciales de la tienda, con o sin cuenta de usuario.';
COMMENT ON TABLE public.categorias IS
    'Categorías del catálogo de productos.';
COMMENT ON TABLE public.productos IS
    'Catálogo de productos y su stock registrado.';
COMMENT ON TABLE public.proveedores IS
    'Proveedores de productos de la tienda.';
COMMENT ON TABLE public.productos_proveedores IS
    'Relación entre productos y proveedores.';
COMMENT ON TABLE public.lotes_productos IS
    'Saldos por lote; no se concilian automáticamente con stock_actual.';
COMMENT ON TABLE public.compras_encabezado IS
    'Encabezados de compra; los flujos de escritura aún no están habilitados.';
COMMENT ON TABLE public.compras_detalle IS
    'Detalles de compra; insertar filas no modifica inventario automáticamente.';
COMMENT ON TABLE public.ventas_encabezado IS
    'Encabezados de venta; los flujos de escritura aún no están habilitados.';
COMMENT ON TABLE public.ventas_detalle IS
    'Detalles de venta; insertar filas no modifica inventario automáticamente.';
COMMENT ON TABLE public.promociones IS
    'Promociones definidas para productos.';
COMMENT ON TABLE public.productos_promociones IS
    'Relación entre productos y promociones.';
COMMENT ON TABLE public.movimientos_inventario IS
    'Registro reservado para el futuro flujo transaccional de inventario.';
COMMENT ON COLUMN public.productos.stock_actual IS
    'Stock registrado. No equivale necesariamente a cantidad vendible.';
COMMENT ON COLUMN public.productos.unidad_medida IS
    'Unidad propia del producto; no agregar cantidades de unidades incompatibles.';
COMMENT ON COLUMN public.lotes_productos.cantidad_actual IS
    'Saldo registrado del lote, mostrado por separado del stock del producto.';
COMMENT ON VIEW public.vista_inventario IS
    'Inventario basado en stock registrado; no calcula disponibilidad vendible.';
COMMENT ON VIEW public.vista_productos_por_vencer IS
    'Lotes con saldo registrado y vencimiento dentro de los próximos 30 días.';

-- Bloqueo base aplicado antes del primer COMMIT. La migración de acceso
-- posterior será la única que conceda SELECT condicionado a authenticated.
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
    public.movimientos_inventario,
    public.vista_inventario,
    public.vista_productos_stock_bajo,
    public.vista_productos_por_vencer,
    public.vista_promociones_activas,
    public.vista_ventas_resumen
FROM PUBLIC, anon, authenticated, service_role;

-- No se crean actualizar_stock, actualizar_stock_lote,
-- registrar_movimiento_inventario ni sus triggers. El diseño de escrituras,
-- confirmaciones, anulaciones, devoluciones y ajustes queda pendiente.

COMMIT;
