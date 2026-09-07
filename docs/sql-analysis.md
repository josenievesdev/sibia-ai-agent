# Análisis del SQL original de SIBIA

## Procedencia y alcance

Este análisis corresponde al SQL suministrado en la conversación y conservado en `database/reference/sibia-original.sql`. No se ejecutó ni se envió a Supabase.

El script mezcla definición de estructura y datos ficticios. Los productos, clientes, proveedores, cantidades, precios, lotes y promociones incluidos son ejemplos; no describen necesariamente la tienda real.

## Inventario de objetos

### Tablas y relaciones

| Tabla | Finalidad | Relaciones principales |
| --- | --- | --- |
| `roles` | Catálogo de roles `cliente`, `empleado`, `admin`. | Referenciada por `usuarios.id_rol`. |
| `usuarios` | Perfil enlazado uno a uno con `auth.users`. | Pertenece a `roles`; referencia desde sesiones, compras, ventas y movimientos. |
| `sesiones_auditoria` | Inicio, fin, IP, dispositivo y estado de sesiones. | Pertenece a `usuarios`. |
| `clientes` | Cliente comercial, tenga o no cuenta de acceso. | Referencia opcional desde ventas. No está enlazado a `usuarios`. |
| `categorias` | Clasificación de productos. | Tiene muchos `productos`. |
| `productos` | Catálogo, precios, unidad y existencia general. | Pertenece a categoría; se relaciona con proveedores, lotes, compras, ventas, promociones y movimientos. |
| `proveedores` | Datos comerciales y de contacto del proveedor. | Compras y relación muchos a muchos con productos. |
| `productos_proveedores` | Oferta de un producto por proveedor. | PK compuesta producto/proveedor; incluye precio de referencia y proveedor principal. |
| `lotes_productos` | Cantidades y vencimiento por lote. | Pertenece a producto; referencia opcional desde detalles y movimientos. |
| `compras_encabezado` | Proveedor, usuario, fecha, totales y estado de una compra. | Pertenece a proveedor y usuario; tiene detalles. |
| `compras_detalle` | Producto, lote, cantidad, costo y subtotal comprado. | Pertenece a compra, producto y lote opcional. |
| `ventas_encabezado` | Cliente opcional, vendedor, fecha, pago, totales y estado. | Pertenece a usuario y opcionalmente a cliente; tiene detalles. |
| `ventas_detalle` | Producto, lote, cantidad, precio, descuento y subtotal vendido. | Pertenece a venta, producto y lote opcional. |
| `promociones` | Descuento porcentual o fijo y periodo de vigencia. | Relación muchos a muchos con productos. |
| `productos_promociones` | Asociación de promociones y productos. | PK compuesta producto/promoción. |
| `movimientos_inventario` | Historial de entrada, salida o ajuste. | Pertenece a producto, usuario y lote opcional. |

Todas las claves primarias propias usan UUID. Las relaciones de catálogo y operaciones usan en general `ON DELETE RESTRICT`; al eliminar un cliente, una venta conserva el registro y establece `id_cliente` en `NULL`.

### Vistas

| Vista | Respuesta prevista |
| --- | --- |
| `vista_inventario` | Producto, categoría, precios, stock, estado y bandera de stock bajo. |
| `vista_productos_stock_bajo` | Productos activos cuyo stock general es menor o igual al mínimo. |
| `vista_productos_por_vencer` | Lotes con cantidad positiva que vencen entre hoy y 30 días. |
| `vista_promociones_activas` | Promociones marcadas activas, dentro de fechas y asociadas a productos activos. |
| `vista_ventas_resumen` | Encabezados de venta con cliente opcional y nombre del vendedor. |

### Funciones

| Función | Efecto |
| --- | --- |
| `actualizar_stock` | Bloquea un producto y suma una entrada o resta una salida si hay stock. |
| `actualizar_stock_lote` | Bloquea un lote y suma una entrada o resta una salida si hay cantidad. |
| `registrar_movimiento_inventario` | Inserta un movimiento y devuelve su UUID. |
| `procesar_compra_detalle` | Tras insertar un detalle, aumenta producto/lote y registra una entrada. |
| `procesar_venta_detalle` | Tras insertar un detalle, disminuye producto/lote y registra una salida. |
| `crear_perfil_usuario` | Como `SECURITY DEFINER`, crea un perfil cliente tras insertar en `auth.users`. |

### Triggers

| Trigger | Evento |
| --- | --- |
| `trg_procesar_compra_detalle` | `AFTER INSERT` en `compras_detalle`. |
| `trg_procesar_venta_detalle` | `AFTER INSERT` en `ventas_detalle`. |
| `on_auth_user_created` | `AFTER INSERT` en `auth.users`. |

## Preguntas empresariales posibles

### Catálogo e inventario

`productos`, `categorias` y `vista_inventario` permiten buscar productos por nombre o código, listar categorías, consultar precio de compra/venta, unidad, estado, stock general, mínimo y condición de stock bajo. Se puede responder “¿cuánto hay de este producto?”, pero la cantidad debe presentarse con su unidad y aclarar que procede de `stock_actual`.

`lotes_productos` y `vista_productos_por_vencer` permiten consultar lotes, cantidad por lote, fecha de ingreso, vencimiento y productos próximos a vencer. La vista fija el horizonte en 30 días; una tool parametrizada necesitará consultar las tablas con una consulta controlada.

`movimientos_inventario` permite revisar entradas, salidas y ajustes por producto, lote, usuario, fecha, motivo y referencia. Debe restringirse a roles internos.

### Proveedores y compras

`proveedores` y `productos_proveedores` permiten saber quién suministra un producto, cuál figura como principal, el código del proveedor y el precio de compra de referencia. El esquema no garantiza que solo exista un proveedor principal por producto.

`compras_encabezado` y `compras_detalle` permiten consultar compras por periodo, proveedor, usuario o producto, junto con cantidades y precios históricos registrados. Los totales almacenados no están garantizados por la base y por ahora deben tratarse como datos declarados, no recalculados.

### Ventas y clientes

`ventas_encabezado`, `ventas_detalle` y `vista_ventas_resumen` permiten consultar ventas por fecha, cliente, vendedor, producto, método de pago y estado. Se pueden calcular unidades vendidas e importes por periodos si se excluyen o revierten correctamente las anulaciones y se agrupa por unidad cuando corresponda.

`clientes` contiene contacto y dirección. Estos datos personales no deben estar disponibles para cualquier usuario ni enviarse al modelo si la pregunta no los necesita.

### Promociones

`promociones`, `productos_promociones` y `vista_promociones_activas` permiten saber qué promoción está asociada a un producto y si está vigente según estado y fechas. No permiten demostrar qué promoción se aplicó realmente a una línea de venta.

### Usuarios y auditoría

`usuarios`, `roles` y `sesiones_auditoria` permiten identificar roles, estado del perfil y sesiones registradas. Son datos administrativos y de seguridad, no una fuente general para el asistente comercial.

## Información que no existe

- No hay vínculo entre un registro de `clientes` y una cuenta de `usuarios`.
- No hay impuestos, moneda explícita, número legal de factura, resolución fiscal ni desglose tributario.
- No hay devoluciones, reembolsos, notas crédito ni reversos formales de compra o venta.
- No hay cuentas por cobrar, cuentas por pagar, caja, turnos de caja ni conciliación de pagos.
- No hay detalle de pagos múltiples por venta; solo un método en el encabezado.
- No hay marca, fabricante, múltiples códigos de barras, presentaciones equivalentes ni conversiones entre unidades.
- No hay historial independiente de cambios de precio ni vigencias de costos fuera de detalles de compra.
- No hay atribución de una promoción o del descuento exacto aplicado a cada venta.
- No hay pedidos, cotizaciones ni estados de entrega.
- No hay política de valoración de inventario ni costo de venta calculado.
- No hay un indicador que defina qué productos exigen lote; `id_lote` simplemente es opcional.
- No hay regla que identifique stock reservado, dañado, vencido o no vendible.
- No hay zona horaria comercial configurada en el esquema.
- No hay ubicaciones, y no se propone agregarlas porque no son requisito de esta tienda.

## Hallazgos bloqueantes antes de cargar el esquema

### 1. No existen RLS ni políticas de autorización

El script no habilita Row Level Security, no crea políticas y no define una matriz de permisos. En Supabase esto puede exponer tablas de negocio, clientes, usuarios y auditoría a roles de API según los grants efectivos del proyecto.

Antes de cargar datos se debe definir acceso para cliente, empleado y admin, habilitar RLS en todas las tablas expuestas y probar cada política con JWT reales. El backend futuro debe consultar con identidad de usuario, no con `service_role`.

### 2. Las vistas pueden eludir la intención de RLS

Las vistas no declaran `security_invoker`. Según versión y propiedad, una vista ejecutada con privilegios del propietario puede no respetar las políticas como espera el consumidor. Cada vista expuesta debe recrearse con semántica de invocador compatible con la versión de PostgreSQL de Supabase y recibir grants mínimos.

### 3. Las funciones públicas carecen de permisos mínimos

Las funciones están en `public` y el script no revoca `EXECUTE` a `PUBLIC`, `anon` o `authenticated`. Un cliente podría invocar funciones de stock por RPC, incluso sin pasar por los triggers y sin autorización de negocio. Se deben revocar permisos por defecto, conceder solo lo necesario y evitar exponer directamente las funciones mutadoras.

Las funciones mutadoras tampoco validan `p_cantidad > 0`. Una cantidad negativa puede invertir el efecto de una entrada o salida si la función se invoca directamente. `actualizar_stock_lote` además ignora silenciosamente un tipo distinto de `ENTRADA` o `SALIDA`.

Aplicar RLS sin rediseñar este límite tampoco basta: los triggers se ejecutan por defecto con los permisos del invocador. Si se niega al usuario actualizar productos/lotes e insertar movimientos, el trigger de un detalle legítimo fallará; si se conceden esos permisos, el usuario puede evitar el flujo controlado. La migración corregida necesita una única operación transaccional privilegiada y estrecha, preferiblemente fuera del esquema expuesto, con `SECURITY DEFINER`, propietario controlado, `search_path` seguro, validación de `auth.uid()`, grants por firma exacta y DML directo revocado. También se deben cambiar los privilegios predeterminados para que futuras funciones no recuperen `EXECUTE` público.

### 4. Un detalle puede combinar un producto con el lote de otro producto

En compras, ventas y movimientos, `id_producto` e `id_lote` tienen claves foráneas independientes. Nada exige que el lote pertenezca al mismo producto. Los triggers podrían modificar el stock general del producto A y el stock del lote del producto B en la misma operación.

Se necesita una restricción compuesta o una validación equivalente y pruebas de rechazo. Este punto debe resolverse antes de cualquier operación real.

### 5. Actualizar o eliminar detalles no corrige inventario

Solo hay triggers `AFTER INSERT`. Cambiar cantidad, producto o lote en un detalle ya registrado no revierte el efecto anterior. Eliminar un detalle tampoco restaura el stock. Esto afecta compras y ventas.

La decisión más segura es hacer inmutables los detalles contabilizados y manejar correcciones con operaciones explícitas de reverso, dentro de una transacción. Si se permiten `UPDATE` o `DELETE`, hacen falta triggers completos y auditables para el valor anterior y nuevo. La eliminación de encabezados con detalles está bloqueada por `ON DELETE RESTRICT`, pero un detalle individual sí carece de compensación automática.

### 6. Anular encabezados no revierte stock

Cambiar una compra a `anulada` o una venta a `anulada` solo modifica texto de estado. No genera movimientos compensatorios ni restaura/retira existencias. Además se pueden insertar detalles en un encabezado ya anulado.

Hace falta una función transaccional e idempotente para confirmar y anular documentos, con estados que impidan doble aplicación. No se debe depender de actualizaciones directas desde el cliente.

### 7. Stock general y stock por lotes pueden divergir

No existe una regla que relacione `productos.stock_actual` con la suma de `lotes_productos.cantidad_actual`. Se permite mezclar stock con y sin lote para un mismo producto sin declarar esa intención. También se permite `cantidad_actual > cantidad_inicial` sin explicación.

Antes de operar se debe decidir si todo el stock de un producto controlado por lote debe estar asignado a lotes. Luego deben existir una única ruta transaccional de mutación, una consulta de conciliación y pruebas concurrentes.

### 8. La creación y recepción de lotes puede duplicar cantidades

Un lote puede crearse con `cantidad_actual` ya cargada y luego recibir un `compras_detalle` que vuelve a aumentarla. El esquema no define si el lote nace en cero o si su cantidad inicial representa ya la recepción contabilizada.

La operación de recepción debe crear/identificar el lote y aplicar la cantidad exactamente una vez en una misma transacción.

### 9. Totales y subtotales no están protegidos

La base acepta subtotales que no equivalen a cantidad por precio, descuentos mayores al subtotal y encabezados cuyo total no coincide con sus líneas. Los triggers no calculan ni actualizan totales.

El esquema ya impide importes almacenados negativos, pero se debe decidir una regla de redondeo, calcular importes en una operación controlada e impedir descuentos excesivos o fórmulas incoherentes.

### 10. El script completo no es una migración idempotente

`CREATE TABLE IF NOT EXISTS` no actualiza tablas preexistentes ni garantiza que sus restricciones coincidan. Por tanto, reejecutar el archivo no equivale a aplicar una migración versionada. Estructura y semillas deben separarse en migraciones revisables.

### 11. Las promociones de prueba se duplican al reejecutar

`promociones.nombre` no es único y su inserción no usa `ON CONFLICT`. Cada ejecución crea tres promociones nuevas. Las asociaciones posteriores unen por nombre y pueden asociar el producto a todas las copias. Roles, categorías, productos, clientes y proveedores de prueba sí usan conflictos basados en sus columnas únicas; los lotes sembrados también, siempre que el número no sea nulo.

### 12. Falta definir el tratamiento de datos semilla

El mismo script carga estructura y registros ficticios. Ejecutarlo en el proyecto destinado a producción mezclaría ejemplos con datos reales. Las semillas deben quedar en un archivo de desarrollo explícito, nunca en la migración de producción.

El rol `cliente` no es un dato de prueba prescindible: `crear_perfil_usuario` depende de él. Los roles requeridos deben provisionarse como datos de referencia en una migración de producción separada. El trigger no crea perfiles para usuarios de Auth que ya existan, por lo que también hace falta una decisión de backfill.

### 13. Los roles de aplicación aún permiten escalada de privilegios

Una fila en `roles` no confiere permisos PostgreSQL. Las políticas deben impedir que un usuario cambie su propio `usuarios.id_rol` o `estado`, comprobar que el perfil esté activo y evitar recursión al consultar `usuarios` desde sus propias políticas. Cualquier función auxiliar de autorización debe tener propietario y permisos mínimos.

`SET search_path = public` solo es seguro si ningún rol no confiable puede crear objetos en `public`. Es preferible un `search_path` vacío o limitado con todas las referencias cualificadas, además de revocar `CREATE` donde corresponda.

### 14. El historial de movimientos no es una fuente de verdad

Las funciones `actualizar_stock` y `actualizar_stock_lote` pueden cambiar saldos sin crear un movimiento. `registrar_movimiento_inventario` crea una fila pero no cambia saldos. Si hay DML directo, se pueden fabricar o borrar movimientos sin afectar inventario y modificar stock sin dejar rastro.

`AJUSTE` admite solo una cantidad positiva y no guarda dirección ni saldo anterior/nuevo; `actualizar_stock` lo rechaza y la función de lotes lo ignora. Esto debe resolverse antes de llamar “auditoría” al historial o usarlo para reconstruir existencias. Saldos y movimiento deben escribirse en la misma operación autorizada e indivisible.

### 15. RLS no resuelve la seguridad por columnas

RLS filtra filas, no oculta columnas. `vista_inventario` incluye `precio_compra`, y `vista_ventas_resumen` incluye nombres e importes. Una vista `security_invoker` seguiría exponiendo esas columnas si el usuario obtiene acceso a ella.

Se necesitan vistas o funciones de lectura específicas por caso de uso, tipos de retorno mínimos, grants de columna cuando sean apropiados y acceso directo revocado a relaciones más amplias. También se debe decidir si `public` seguirá siendo un esquema expuesto por PostgREST o si la API utilizará un esquema dedicado.

## Mejoras posteriores

### Integridad de negocio

- Garantizar como máximo un proveedor principal por producto mediante un índice único parcial.
- Definir si `numero_lote` es obligatorio para productos con control de lotes. Una restricción única permite múltiples valores `NULL`.
- Validar que cantidades y tipos recibidos por toda función sean válidos, no solo por constraints de tablas.
- Impedir detalles en documentos anulados y definir estados como borrador, confirmado y anulado.
- Definir devoluciones y ajustes como movimientos compensatorios, nunca como edición silenciosa del historial.
- Registrar el vínculo entre el movimiento y su documento con claves tipadas; `referencia VARCHAR` no garantiza integridad.
- Evaluar una fuente única de verdad para stock: libro de movimientos con saldo derivado, o saldo materializado mantenido exclusivamente por funciones transaccionales.
- Definir cómo se elige lote en ventas, por ejemplo FEFO, y qué ocurre con lotes vencidos.
- Definir si `productos_proveedores` es una relación informativa o una restricción: hoy una compra puede incluir un producto que no esté asociado a su proveedor.
- Impedir operaciones con producto, proveedor, usuario o cliente inactivo cuando corresponda. Los triggers actuales solo verifican claves foráneas y stock.

### Estado y disponibilidad del producto

`productos.estado = 'activo'` indica disponibilidad administrativa en catálogo; no significa que haya existencias. Un producto activo puede tener stock cero y uno inactivo puede conservar stock. Las tools y la UI deben devolver por separado `estado`, `stock_actual` y un estado calculado de existencia.

Las promociones activas tampoco comprueban stock. Esto es válido si “promoción vigente” y “producto comprable” se presentan como conceptos distintos.

“Con existencias” tampoco equivale necesariamente a “vendible”: el saldo general puede corresponder a lotes vencidos o no coincidir con lotes. La vista de próximos a vencer incluye productos inactivos y no devuelve su estado. Hasta definir reglas de lotes, las tools deben llamar al dato `stock registrado`, no disponibilidad para venta.

### Unidades

`unidad_medida` es un catálogo cerrado útil para mostrar cantidades, pero no expresa equivalencias. No se deben sumar litros, kilogramos, botellas, cajas o unidades en un único total de cantidad. Los reportes deben agrupar por producto y unidad; los totales monetarios sí pueden agregarse cuando la moneda esté definida.

También falta decidir si un producto “Arroz 1 kg” vendido como una bolsa debe usar `unidad`, `bolsa` o `kilogramo`. La semántica debe ser uniforme antes de importar el catálogo real.

Los campos `NUMERIC(12,3)` permiten fracciones de botellas, paquetes, latas y unidades. Si ciertas unidades solo admiten enteros, hace falta una validación por producto o unidad.

### Índices

Los índices explícitos sobre `productos.codigo_referencia` y `usuarios.correo` duplican los índices creados por `UNIQUE`. Conviene eliminarlos en la migración corregida.

Faltan índices útiles en varias claves foráneas y filtros, entre ellos detalles por encabezado, compras por usuario, asociaciones por proveedor/promoción y movimientos por lote o responsable. Deben elegirse con consultas reales y `EXPLAIN`, no agregarse todos preventivamente.

La búsqueda por nombre con B-tree no resuelve bien coincidencias parciales ni tolerancia a acentos. Primero debe probarse búsqueda controlada; después se puede evaluar `pg_trgm` o una columna normalizada.

### Usuarios y auditoría

- `crear_perfil_usuario` presupone que existe el rol `cliente`; si no existe, el alta falla por `id_rol NOT NULL`.
- `auth.users.email` puede no existir en ciertos métodos de autenticación, mientras `usuarios.correo` es obligatorio.
- El correo único es sensible a mayúsculas salvo normalización o `citext`.
- El nombre tomado de metadatos es entrada del usuario y debe tratarse como tal.
- La función `SECURITY DEFINER` sí fija `search_path`, pero aun así debe tener propietario, grants y propósito revisados.
- Las demás funciones deberían fijar un `search_path` seguro y usar nombres cualificados consistentemente.
- `sesiones_auditoria` duplica parte del dominio de sesiones de Auth y almacena IP/dispositivo. Hace falta propósito, fuente confiable, política de retención y acceso administrativo. Un cliente no debe poder declarar su propia IP como dato auditado.
- `usuarios` garantiza como máximo un perfil por usuario de Auth, no que todos los usuarios existentes tengan perfil.
- El `ON DELETE CASCADE` desde Auth puede chocar con relaciones `RESTRICT` de sesiones y documentos. Se necesita una política de conservación y desactivación, no asumir que toda cuenta se puede borrar físicamente.
- El responsable copiado a movimientos procede del encabezado, no de `auth.uid()`, y puede apuntar a cualquier usuario existente. Se deben distinguir actor autenticado, responsable comercial y vendedor.

### Fechas y zona horaria

Las operaciones usan `TIMESTAMPTZ`, lo cual es correcto, pero los reportes diarios necesitan una zona horaria de negocio explícita. `CURRENT_DATE` depende de la zona horaria de la sesión de base de datos. El criterio inclusivo de fin de promociones también debe acordarse.

`fecha_movimiento` usa el momento de inserción, no `fecha_compra` ni `fecha_venta`. En documentos cargados con fecha anterior se deben conservar por separado fecha efectiva y fecha de registro.

### Semillas como fixture de desarrollo

La asociación de proveedores recorre todos los productos existentes y les asigna el proveedor alfabéticamente primero, no solo los productos de prueba. Si cambia ese proveedor, una reejecución puede agregar otra relación marcada principal. Los `ON CONFLICT DO NOTHING` de productos y lotes conservan saldos modificados y fechas de vencimiento antiguas; por tanto, no restauran un fixture determinista. Los saldos iniciales sembrados tampoco tienen movimientos de apertura.

## Propuesta inicial de tools de lectura

No se propone ninguna tool genérica de SQL. Cada tool se implementará mediante consultas predefinidas en el gateway de tienda y aplicará paginación y autorización.

| Tool | Parámetros cerrados | Resultado estructurado | Acceso inicial |
| --- | --- | --- | --- |
| `search_products` | `query`, `categoryId?`, `activeOnly?`, `inStockOnly?`, `limit`, `cursor?` | IDs, código, nombre, categoría, unidad, precio de venta, estado, stock y candidatos numerados. | Usuarios autorizados al catálogo. |
| `get_product` | `productId` | Ficha de producto, estado, precios permitidos, stock y mínimos. | Precio de compra solo para personal autorizado. |
| `list_categories` | `activeOnly?`, `limit`, `cursor?` | Categorías con IDs y estado. | Catálogo. |
| `get_inventory` | `productIds`, `includeLotSummary?` | Stock por producto y unidad, mínimo, bandera de stock bajo y saldos de lotes por separado. | Empleado/admin; versión pública reducida si se decide. |
| `list_product_lots` | `productId`, `expiryFrom?`, `expiryTo?`, `positiveOnly?`, `limit`, `cursor?` | Lotes, cantidades, fechas, días para vencer y estado calculado. | Empleado/admin. |
| `list_expiring_lots` | `daysAhead`, `categoryId?`, `productId?`, `limit`, `cursor?` | Lotes próximos a vencer, siempre separados por producto y unidad. | Empleado/admin. |
| `list_product_suppliers` | `productId`, `principalOnly?`, `limit`, `cursor?` | Proveedores, indicador principal, código y precio de referencia permitido. | Empleado/admin; datos de contacto según permiso. |
| `search_suppliers` | `query`, `activeOnly?`, `limit`, `cursor?` | IDs y datos comerciales autorizados. | Empleado/admin. |
| `list_active_promotions` | `productId?`, `at?`, `limit`, `cursor?` | Promoción, tipo, valor, vigencia y productos asociados. | Catálogo, sin afirmar aplicación a una venta. |
| `get_sales_summary` | `from`, `to`, `groupBy`, `productId?`, `categoryId?`, `limit`, `cursor?` | Importes y cantidades agrupadas por unidad, con criterio de anulaciones explícito. | Empleado limitado/admin según política. |
| `list_purchase_history` | `from`, `to`, `productId?`, `supplierId?`, `limit`, `cursor?` | Compras y líneas autorizadas, costos e importes declarados. | Empleado autorizado/admin. |
| `list_inventory_movements` | `productId`, `from?`, `to?`, `type?`, `limit`, `cursor?` | Movimientos, lote, usuario responsable, motivo y referencia. | Admin o rol operativo específico. |

Los parámetros `productId` usados después de “la segunda” vendrán del estado de sesión, no de una búsqueda textual repetida. La tool debe devolver `empty` cuando una consulta válida no tenga filas, `ambiguous` con candidatos cuando falte selección, `forbidden` cuando el rol no permita el tipo de operación, `not_available` cuando el esquema no posea el dato y `error` ante fallos técnicos. RLS puede ocultar filas como si no existieran; no se debe intentar distinguir ni revelar la existencia de una fila oculta. La autorización de la operación se evalúa antes de consultar y RLS sigue siendo defensa en profundidad.

Antes de implementar, cada esquema de entrada debe cerrar enums y límites: tamaños máximos de búsqueda y arrays, rangos de fecha, valores de `groupBy`, `daysAhead`, orden estable, cursor con desempate y zona horaria. Hasta adoptar una regla de control por lotes, una diferencia entre stock general y suma de lotes se devuelve como dos saldos, no se etiqueta automáticamente como error.

## Decisiones necesarias antes de la migración corregida

1. Matriz exacta de lectura por rol para catálogo, costos, proveedores, ventas, clientes, usuarios y auditoría.
2. Flujo de estados y reversos para compras y ventas.
3. Regla única de stock general frente a lotes y criterio para productos sin lote.
4. Política de selección y bloqueo de lotes al vender.
5. Cálculo de subtotales, descuentos, redondeo, moneda e impuestos aplicables.
6. Separación entre migraciones de producción y semillas de desarrollo.
7. Métodos de autenticación permitidos y campos obligatorios del perfil.
8. Zona horaria comercial y límites de fecha para reportes.
