# Slop València

València en 3D con [three.js](https://threejs.org/), WebGPURenderer y TSL, a escala real:
- Ciutat Vella con el Micalet, la catedral, la Llotja y las torres de Serrans y Quart
- el Ensanche y Russafa, con su Mercat de Russafa de lamas de colores
- el Jardí del Túria, la Ciutat de les Arts i les Ciències, Mestalla
- el puerto, la Marina y la Malva-rosa

Recórrela a pie, en taxi, en bici, en patinete o en helicóptero.

Es un remix de [Slop Barcelona](https://github.com/biko8/slop-barcelona), a su vez remix de
[Slop New York](https://github.com/mrdoob/slop-newyork/): el mismo motor (tráfico, peatones, iluminación, materiales
TSL, cámaras, audio) con la geografía y los edificios reales de València.

## Ejecutarlo

Es una web estática: sírvela con cualquier servidor (`python3 -m http.server`) y abre `index.html` en un navegador
con WebGPU. La primera carga baja unos 5 MB (código, edificios, árboles y la ortofoto del entorno).

## Qué es real

- **Calles, manzanas, parques, costa:** OpenStreetMap (`tools/bcn-extract.py`, `tools/build-bcn-geodata.mjs`). El marco
  del mundo: 1 unidad = 1 m, origen en la Plaça de l'Ajuntament, ejes girados −28,6° con la cuadrícula del Ensanche.
- **Edificios:** los 20.028 edificios del Catastro en la ciudad detallada, a su altura medida por PNOA-LiDAR. Por
  área, el 94 % de las alturas vienen directamente del LiDAR. Los tejados también salen del LiDAR: azoteas a su cota
  real, 557 tejados a dos aguas y 8.894 casetones. El color de cada tejado sale de la ortofoto PNOA.
  `tools/realism/build-buildings.py` y `roof-colors.py` generan `js/vlc-buildings.bin.gz`.
- **Fachadas:** paleta medida en fotos de referencia abiertas, asignada por año de construcción (Catastro), barrio y
  altura: piedra crema del Ensanche, revocos ocre, salmón y almagra de Ciutat Vella, ladrillo de los 60-70, revoco
  gris racionalista, blanco moderno, zócalos de azulejo en los Poblats Marítims.
- **Monumentos:** modelos procedurales propios, dimensionados con el perfil LiDAR de cada uno y con colisiones con la
  forma de su planta
  (`tools/realism/landmark-heights.py` → `js/vlc-landmark-heights.js`).
- **Árboles:** los 86.267 árboles del inventario municipal en la ciudad detallada, con su especie (naranjos, palmeras,
  plátanos…) y su altura (`fetch-trees.py`, `build-trees.py` → `js/vlc-trees.bin.gz`).
- **Suelo del entorno:** ortofoto PNOA (`make-ground.py` → `js/vlc-ground.jpg`).
- **Gente:** además de los peatones de las aceras, la Plaça de l'Ajuntament está llena: 700 personas que pasean,
  charlan en grupos y se paran a mirar (`js/plaza-crowd.js`).
- **Comercios:** cada comercio, bar y restaurante de OpenStreetMap (6.403) tiene su rótulo en la fachada donde está,
  sobre su escaparate. El rótulo dice solo el oficio (FORN, FARMÀCIA, BAR, FRUITERIA…), nunca el nombre del negocio, y
  sin marcas ni logotipos. Las farmacias llevan su cruz verde y los locales vacíos el cartel de ES LLOGA / SE ALQUILA
  (`tools/shops-extract.py`, `tools/build-shops.mjs` → `js/vlc-shops.js`, `js/shop-signs.js`).
- **Autobuses y taxis:** los autobuses llevan líneas y destinos reales de la EMT (relaciones de OpenStreetMap), sin
  logotipo. Los taxis son blancos, como en València, rotulados con TAXI y su licencia.
- **Sol:** su posición real sobre València (39,47° N) en cada momento del día.

Comprobaciones, contra datos que la construcción no usa (`tools/realism/verify.py`, `docs/realism-plan.md`):

| Comprobación | Resultado |
|---|---|
| Alturas frente al vuelo LiDAR independiente de 2015 | mediana 0,18 m (antes 5,18 m) |
| Cota de las azoteas | mediana 0,11 m |
| Huellas frente al Catastro | IoU 0,90 |
| Desplazamiento frente al LiDAR | 0–1 m |
| Alturas de 17 monumentos frente al LiDAR | dentro del 2 % |

## Reconstruir los datos

Hace falta un entorno con GDAL, PDAL y GeoPandas (conda-forge: `gdal pdal python-pdal geopandas rasterio`). Los pasos
y fuentes exactas están en `docs/realism-plan.md`:
- descarga del Catastro (con su certificado raíz FNMT)
- teselas LiDAR del CNIG
- WMTS del IGN
- API CKAN de València

## Tests

```sh
node --test tests/*.test.cjs tests/*.test.mjs
```

## Licencia y datos

El código está bajo la [licencia MIT](LICENSE) (© Mr.doob y colaboradores).

Datos:
- © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL 1.0); los datos derivados de OSM en
  `js/` siguen bajo ODbL
- edificios: Dirección General del Catastro (INSPIRE Buildings, uso libre con mención)
- LiDAR: LiDAR-PNOA-cob3 2022-2025 y PNOA 2015, CC BY 4.0 scne.es
- ortofoto: PNOA cedido por © Instituto Geográfico Nacional, CC BY 4.0 scne.es
- Font: Ajuntament de València, [portal de datos abiertos](https://opendata.vlci.valencia.es/) (CC BY 4.0). Conjuntos
  usados (descargas, sumas y fechas en `tools/data/vlci-manifest.json`):
  - [Arbolado](https://opendata.vlci.valencia.es/dataset/arbratge-arbolado): árboles
  - [Mobiliario urbano](https://opendata.vlci.valencia.es/dataset/servicios-e-instalaciones): farolas
  - [Cartografía Base Bordillos](https://opendata.vlci.valencia.es/dataset/cartografia-base-vorades-bordillos): bordillos, imbornales y plazas de aparcamiento
  - [Señalización Horizontal](https://opendata.vlci.valencia.es/dataset/senalizacion-horizontal): marcas viales
  - [Aparcamientos no Regulados](https://opendata.vlci.valencia.es/dataset/aparcaments-no-regulats-aparcamientos-no-regulados): coches aparcados
  - [Aparcamientos ORA](https://opendata.vlci.valencia.es/dataset/aparcaments-ora-aparcamientos-ora): coches aparcados
  - [Aparcamiento para motos](https://opendata.vlci.valencia.es/dataset/aparcament-per-a-motos-aparcamiento-para-motos): motos aparcadas
  - [Taxis](https://opendata.vlci.valencia.es/dataset/taxis): paradas de taxi
  - [Imbornales](https://opendata.vlci.valencia.es/dataset/embornals-imbornales): imbornales
  - [Contenedores residuos sólidos](https://opendata.vlci.valencia.es/dataset/contenidors-residus-solids-contenidores-residuos-solidos): contenedores
  - [Contenedores Vidrio](https://opendata.vlci.valencia.es/dataset/contenidors-vidre-contenedores-vidrio): contenedores
  - [Papeleras](https://opendata.vlci.valencia.es/dataset/papereres-papeleras): papeleras
  - [Bancos en vía pública](https://opendata.vlci.valencia.es/dataset/bancs-en-via-publica-bancos-en-via-publica): bancos
  - [Fuentes de Agua Pública](https://opendata.vlci.valencia.es/dataset/fonts-daigua-publica-fuentes-de-agua-publica): fuentes
  - [Bolardos extraibles](https://opendata.vlci.valencia.es/dataset/pilons-extraibles-bolardos-extraibles): bolardos
  - [Aparcamientos Bicicletas](https://opendata.vlci.valencia.es/dataset/aparcaments-bicicletes-aparcamientos-bicicletas): aparcabicis
  - [EMT](https://opendata.vlci.valencia.es/dataset/emt): paradas de autobús
  - [Quiosco ONCE](https://opendata.vlci.valencia.es/dataset/quiosc-once-quiosco-once): quioscos
  - [Quioscos flores](https://opendata.vlci.valencia.es/dataset/quioscs-flors-quioscos-flores): quioscos
  - [Quioscos prensa](https://opendata.vlci.valencia.es/dataset/quioscs-premsa-quioscos-prensa): quioscos
  - [Cartografía Base Toponimia](https://opendata.vlci.valencia.es/dataset/cartografia-base-toponimia-toponimia): placas de calle
  - [Ejes lineales de las calles](https://opendata.vlci.valencia.es/dataset/eixos-lineals-dels-carrers): placas de calle
  - [Portales de las calles](https://opendata.vlci.valencia.es/dataset/portals-dels-carrers-portales-de-las-calles): números de portal
  - [Manzanas catastrales con datos de población](https://opendata.vlci.valencia.es/dataset/illa-de-cases-cadastrals-amb-dades-de-poblacio): densidad de peatones
  - [Barrios](https://opendata.vlci.valencia.es/dataset/barris-barrios): densidad de peatones
  - [Aparcamientos por distritos-barrios](https://opendata.vlci.valencia.es/dataset/car-parks-by-districts-neighborhoods): densidad de peatones

Las fotos de referencia usadas para calibrar fachadas son de Wikimedia Commons (CC BY / CC BY-SA). Solo se usaron como
referencia visual y no se distribuyen; sus autores están en `reference/credits.json`.
