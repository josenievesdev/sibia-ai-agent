-- SIBIA: datos opcionales de demostración.
-- NO ejecutar en producción ni tratar estos registros como datos reales.
-- Este archivo no forma parte de supabase/migrations y no se carga solo.

BEGIN;

INSERT INTO public.categorias (nombre, descripcion, estado)
VALUES
    ('Bebidas', 'Gaseosas, aguas, jugos y otras bebidas', 'activo'),
    ('Abarrotes', 'Productos básicos de mercado', 'activo'),
    ('Snacks y Confitería', 'Papas, galletas, chocolates y dulces', 'activo'),
    ('Lácteos', 'Leche, yogur y productos derivados', 'activo'),
    ('Aseo', 'Productos de limpieza y aseo', 'activo'),
    ('Hogar', 'Productos básicos para el hogar', 'activo'),
    ('Cuidado Personal', 'Productos de higiene y cuidado personal', 'activo'),
    ('Panadería', 'Pan y productos de panadería', 'activo')
ON CONFLICT (nombre)
DO UPDATE SET
    descripcion = EXCLUDED.descripcion,
    estado = EXCLUDED.estado;

INSERT INTO public.proveedores (
    nombre,
    nit,
    telefono,
    correo,
    direccion,
    contacto,
    estado
)
VALUES
    (
        'Distribuciones La 30',
        '900000001-1',
        '3001112233',
        'contacto@distribucionesla30.test',
        'Carrera 30 # 10-20',
        'Carlos Rodríguez',
        'activo'
    ),
    (
        'Comercializadora El Ahorro',
        '900000002-2',
        '3012223344',
        'ventas@elahorro.test',
        'Calle 20 # 15-30',
        'María Gómez',
        'activo'
    ),
    (
        'Mayorista del Barrio',
        '900000003-3',
        '3023334455',
        'pedidos@mayoristadelbarrio.test',
        'Carrera 12 # 25-40',
        'Andrés Martínez',
        'activo'
    ),
    (
        'Distribuciones Andinas',
        '900000004-4',
        '3034445566',
        'ventas@distribucionesandinas.test',
        'Calle 45 # 20-10',
        'Laura Pérez',
        'activo'
    )
ON CONFLICT (nit)
DO UPDATE SET
    nombre = EXCLUDED.nombre,
    telefono = EXCLUDED.telefono,
    correo = EXCLUDED.correo,
    direccion = EXCLUDED.direccion,
    contacto = EXCLUDED.contacto,
    estado = EXCLUDED.estado;

WITH productos_demo (
    codigo_referencia,
    nombre_producto,
    descripcion,
    categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo
) AS (
    VALUES
        (
            'BEB-001',
            'Gaseosa Cola 1.5L',
            'Gaseosa sabor cola presentación 1.5 litros',
            'Bebidas',
            'botella',
            7000,
            4500,
            30,
            10
        ),
        (
            'BEB-002',
            'Agua 600ml',
            'Agua embotellada de 600ml',
            'Bebidas',
            'botella',
            3000,
            1800,
            50,
            15
        ),
        (
            'ABA-001',
            'Arroz Blanco 1kg',
            'Arroz blanco presentación de 1 kilogramo',
            'Abarrotes',
            'kilogramo',
            4500,
            3200,
            25,
            8
        ),
        (
            'ABA-002',
            'Aceite Vegetal 1L',
            'Aceite vegetal de cocina',
            'Abarrotes',
            'litro',
            8500,
            6500,
            20,
            6
        ),
        (
            'SNK-001',
            'Papas de Paquete',
            'Papas fritas de paquete',
            'Snacks y Confitería',
            'bolsa',
            2500,
            1500,
            40,
            10
        ),
        (
            'SNK-002',
            'Galletas de Chocolate',
            'Galletas con sabor a chocolate',
            'Snacks y Confitería',
            'paquete',
            3000,
            1800,
            35,
            10
        ),
        (
            'LAC-001',
            'Leche Entera 1L',
            'Leche entera larga vida',
            'Lácteos',
            'litro',
            4500,
            3300,
            20,
            8
        ),
        (
            'LAC-002',
            'Yogur Natural',
            'Yogur natural individual',
            'Lácteos',
            'unidad',
            2500,
            1600,
            15,
            5
        ),
        (
            'ASE-001',
            'Jabón de Ropa',
            'Jabón para lavar ropa',
            'Aseo',
            'unidad',
            3500,
            2200,
            18,
            5
        ),
        (
            'HOG-001',
            'Papel Higiénico',
            'Papel higiénico de uso doméstico',
            'Hogar',
            'paquete',
            7000,
            4800,
            15,
            5
        ),
        (
            'PAN-001',
            'Pan Tajado',
            'Pan tajado empacado',
            'Panadería',
            'paquete',
            6500,
            4500,
            10,
            4
        ),
        (
            'BEB-003',
            'Jugo en Caja',
            'Jugo de fruta en caja individual',
            'Bebidas',
            'unidad',
            2500,
            1500,
            25,
            8
        )
)
INSERT INTO public.productos (
    codigo_referencia,
    nombre_producto,
    descripcion,
    id_categoria,
    unidad_medida,
    precio_venta,
    precio_compra,
    stock_actual,
    stock_minimo,
    estado
)
SELECT
    d.codigo_referencia,
    d.nombre_producto,
    d.descripcion,
    c.id_categoria,
    d.unidad_medida,
    d.precio_venta,
    d.precio_compra,
    d.stock_actual,
    d.stock_minimo,
    'activo'
FROM productos_demo AS d
INNER JOIN public.categorias AS c
    ON c.nombre = d.categoria
ON CONFLICT (codigo_referencia)
DO UPDATE SET
    nombre_producto = EXCLUDED.nombre_producto,
    descripcion = EXCLUDED.descripcion,
    id_categoria = EXCLUDED.id_categoria,
    unidad_medida = EXCLUDED.unidad_medida,
    precio_venta = EXCLUDED.precio_venta,
    precio_compra = EXCLUDED.precio_compra,
    stock_actual = EXCLUDED.stock_actual,
    stock_minimo = EXCLUDED.stock_minimo,
    estado = EXCLUDED.estado;

INSERT INTO public.clientes (nombre, documento, telefono, estado)
VALUES
    ('Juan Pérez', '100000001', '3101112233', 'activo'),
    ('María Rodríguez', '100000002', '3112223344', 'activo'),
    ('Carlos Gómez', '100000003', '3123334455', 'activo')
ON CONFLICT (documento)
DO UPDATE SET
    nombre = EXCLUDED.nombre,
    telefono = EXCLUDED.telefono,
    estado = EXCLUDED.estado;

-- Solo relaciona los productos de demostración, no todo el catálogo existente.
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
    NOT EXISTS (
        SELECT 1
        FROM public.productos_proveedores AS existente
        WHERE existente.id_producto = p.id_producto
          AND existente.id_proveedor <> pr.id_proveedor
          AND existente.es_principal
    )
FROM public.productos AS p
INNER JOIN public.proveedores AS pr
    ON pr.nit = '900000002-2'
WHERE p.codigo_referencia IN (
    'BEB-001',
    'BEB-002',
    'ABA-001',
    'ABA-002',
    'SNK-001',
    'SNK-002',
    'LAC-001',
    'LAC-002',
    'ASE-001',
    'HOG-001',
    'PAN-001',
    'BEB-003'
)
ON CONFLICT (id_producto, id_proveedor)
DO UPDATE SET
    precio_compra_referencia = EXCLUDED.precio_compra_referencia,
    es_principal = EXCLUDED.es_principal;

WITH lotes_demo (
    codigo_referencia,
    numero_lote,
    cantidad_inicial,
    cantidad_actual,
    dias_para_vencer
) AS (
    VALUES
        ('LAC-001', 'LOTE-LECHE-001', 20, 20, 45),
        ('LAC-002', 'LOTE-YOGUR-001', 15, 15, 20),
        ('SNK-002', 'LOTE-GALLETAS-001', 35, 35, 120)
)
INSERT INTO public.lotes_productos (
    id_producto,
    numero_lote,
    cantidad_inicial,
    cantidad_actual,
    fecha_ingreso,
    fecha_vencimiento
)
SELECT
    p.id_producto,
    d.numero_lote,
    d.cantidad_inicial,
    d.cantidad_actual,
    CURRENT_DATE,
    CURRENT_DATE + d.dias_para_vencer
FROM lotes_demo AS d
INNER JOIN public.productos AS p
    ON p.codigo_referencia = d.codigo_referencia
ON CONFLICT (id_producto, numero_lote)
DO UPDATE SET
    cantidad_inicial = EXCLUDED.cantidad_inicial,
    cantidad_actual = EXCLUDED.cantidad_actual,
    fecha_ingreso = EXCLUDED.fecha_ingreso,
    fecha_vencimiento = EXCLUDED.fecha_vencimiento;

INSERT INTO public.promociones (
    id_promocion,
    nombre,
    descripcion,
    tipo_promocion,
    valor_descuento,
    fecha_inicio,
    fecha_fin,
    estado
)
VALUES
    (
        '00000000-0000-4000-8000-000000000001',
        'Descuento en bebidas',
        'Descuento especial en bebidas seleccionadas',
        'porcentaje',
        10,
        CURRENT_DATE,
        CURRENT_DATE + 30,
        'activa'
    ),
    (
        '00000000-0000-4000-8000-000000000002',
        'Oferta de galletas',
        'Descuento especial en galletas',
        'valor_fijo',
        500,
        CURRENT_DATE,
        CURRENT_DATE + 20,
        'activa'
    ),
    (
        '00000000-0000-4000-8000-000000000003',
        'Promoción lácteos',
        'Oferta especial en productos lácteos',
        'porcentaje',
        15,
        CURRENT_DATE,
        CURRENT_DATE + 15,
        'activa'
    )
ON CONFLICT (id_promocion)
DO UPDATE SET
    nombre = EXCLUDED.nombre,
    descripcion = EXCLUDED.descripcion,
    tipo_promocion = EXCLUDED.tipo_promocion,
    valor_descuento = EXCLUDED.valor_descuento,
    fecha_inicio = EXCLUDED.fecha_inicio,
    fecha_fin = EXCLUDED.fecha_fin,
    estado = EXCLUDED.estado;

WITH promociones_demo (codigo_referencia, id_promocion) AS (
    VALUES
        ('BEB-001', '00000000-0000-4000-8000-000000000001'::UUID),
        ('SNK-002', '00000000-0000-4000-8000-000000000002'::UUID),
        ('LAC-001', '00000000-0000-4000-8000-000000000003'::UUID)
)
INSERT INTO public.productos_promociones (id_producto, id_promocion)
SELECT p.id_producto, d.id_promocion
FROM promociones_demo AS d
INNER JOIN public.productos AS p
    ON p.codigo_referencia = d.codigo_referencia
ON CONFLICT (id_producto, id_promocion)
DO NOTHING;

-- Los saldos anteriores son aperturas ficticias y no generan movimientos.
-- No se insertan compras, ventas, sesiones, usuarios ni auditoría.

COMMIT;
