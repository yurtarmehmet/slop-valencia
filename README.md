# Slop València

València in 3D at 1:1, built with [three.js](https://threejs.org/), WebGPURenderer and TSL:
- Ciutat Vella with the Micalet, the cathedral, the Llotja and the Serrans and Quart towers
- the Eixample and Russafa, with the colourful slats of the Mercat de Russafa
- the Jardí del Túria, the Ciutat de les Arts i les Ciències, Mestalla
- the port, the Marina and the Malva-rosa beach

Explore it on foot, by taxi, by bike, by scooter or by helicopter.

**[Play it](https://yurtarmehmet.github.io/slop-valencia/)** (needs a browser with WebGPU)

A remix of [Slop Barcelona](https://github.com/biko8/slop-barcelona), itself a remix of
[Slop New York](https://github.com/mrdoob/slop-newyork/): the same engine (traffic, pedestrians, lighting, TSL
materials, cameras, audio) with València's real geography and buildings.

## Running it

It's a static site: serve it with any web server (`python3 -m http.server`) and open `index.html` in a browser with
WebGPU. The first load downloads about 5 MB (code, buildings, trees and the surrounding orthophoto).

## What's real

- **Streets, blocks, parks, coastline:** OpenStreetMap (`tools/bcn-extract.py`, `tools/build-bcn-geodata.mjs`). World
  frame: 1 unit = 1 m, origin at the Plaça de l'Ajuntament, axes rotated −28.6° to match the Eixample grid.
- **Buildings:** all 20,028 Catastro buildings in the detailed city, at their height measured by PNOA-LiDAR. By area,
  94 % of the heights come straight from the LiDAR. Roofs come from the LiDAR too: flat roofs at their real level, 557
  gabled roofs and 8,894 rooftop structures. Each roof's colour is taken from the PNOA orthophoto.
  `tools/realism/build-buildings.py` and `roof-colors.py` produce `js/vlc-buildings.bin.gz`.
- **Facades:** a palette measured from open reference photos, assigned by year of construction (Catastro),
  neighbourhood and height: the cream stone of the Eixample, the ochre, salmon and red-oxide renders of Ciutat Vella,
  1960s-70s brick, grey rationalist render, modern white, and tiled plinths in the Poblats Marítims.
- **Landmarks:** our own procedural models, sized from each one's LiDAR profile, with collisions that follow their
  footprint (`tools/realism/landmark-heights.py` → `js/vlc-landmark-heights.js`).
- **Trees:** all 86,267 trees of the city's tree inventory in the detailed city, with their species (orange trees, palms,
  plane trees…) and height (`fetch-trees.py`, `build-trees.py` → `js/vlc-trees.bin.gz`).
- **Surrounding ground:** PNOA orthophoto (`make-ground.py` → `js/vlc-ground.jpg`).
- **People:** besides the pedestrians on the pavements, the Plaça de l'Ajuntament is full: 700 people strolling,
  chatting in groups and stopping to look around (`js/plaza-crowd.js`).
- **Shops:** every shop, bar and restaurant in OpenStreetMap (6,403) has its sign on its own facade, above its window.
  The sign only names the trade (FORN, FARMÀCIA, BAR, FRUITERIA…), never the business, with no brands or logos.
  Pharmacies carry their green cross and empty premises an ES LLOGA / SE ALQUILA sign
  (`tools/shops-extract.py`, `tools/build-shops.mjs` → `js/vlc-shops.js`, `js/shop-signs.js`).
- **Buses and taxis:** buses show real EMT lines and destinations (OpenStreetMap route relations), without the logo.
  Taxis are white, as in València, marked TAXI with their licence number.
- **Sun:** its real position over València (39.47° N) at every time of day.

Checked against data the build doesn't use (`tools/realism/verify.py`):

| Check | Result |
|---|---|
| Heights vs the independent 2015 LiDAR flight | median 0.18 m (was 5.18 m) |
| Flat roof level | median 0.11 m |
| Footprints vs Catastro | IoU 0.90 |
| Offset vs LiDAR | 0–1 m |
| Heights of 17 landmarks vs LiDAR | within 2 % |

## Rebuilding the data

You need an environment with GDAL, PDAL and GeoPandas (conda-forge: `gdal pdal python-pdal geopandas rasterio`). The
scripts are in `tools/` and fetch from:
- the Catastro download service (with its FNMT root certificate)
- CNIG LiDAR tiles
- the IGN WMTS
- València's CKAN open data API

## Tests

```sh
node --test tests/*.test.cjs tests/*.test.mjs
```

## Licence and data

The code is under the [MIT licence](LICENSE) (© Mr.doob and contributors).

Data:
- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL 1.0); the OSM-derived data in `js/`
  stays under the ODbL
- buildings: Dirección General del Catastro (INSPIRE Buildings, free to use with attribution)
- LiDAR: LiDAR-PNOA-cob3 2022-2025 and PNOA 2015, CC BY 4.0 scne.es
- orthophoto: PNOA courtesy of © Instituto Geográfico Nacional, CC BY 4.0 scne.es
- Font: Ajuntament de València, [open data portal](https://opendata.vlci.valencia.es/) (CC BY 4.0). Datasets
  used (downloads, checksums and dates in `tools/data/vlci-manifest.json`):
  - [Arbolado](https://opendata.vlci.valencia.es/dataset/arbratge-arbolado): trees
  - [Mobiliario urbano](https://opendata.vlci.valencia.es/dataset/servicios-e-instalaciones): street lamps
  - [Cartografía Base Bordillos](https://opendata.vlci.valencia.es/dataset/cartografia-base-vorades-bordillos): kerbs, drains and parking bays
  - [Señalización Horizontal](https://opendata.vlci.valencia.es/dataset/senalizacion-horizontal): road markings
  - [Aparcamientos no Regulados](https://opendata.vlci.valencia.es/dataset/aparcaments-no-regulats-aparcamientos-no-regulados): parked cars
  - [Aparcamientos ORA](https://opendata.vlci.valencia.es/dataset/aparcaments-ora-aparcamientos-ora): parked cars
  - [Aparcamiento para motos](https://opendata.vlci.valencia.es/dataset/aparcament-per-a-motos-aparcamiento-para-motos): parked motorbikes
  - [Taxis](https://opendata.vlci.valencia.es/dataset/taxis): taxi ranks
  - [Imbornales](https://opendata.vlci.valencia.es/dataset/embornals-imbornales): drains
  - [Contenedores residuos sólidos](https://opendata.vlci.valencia.es/dataset/contenidors-residus-solids-contenidores-residuos-solidos): bins
  - [Contenedores Vidrio](https://opendata.vlci.valencia.es/dataset/contenidors-vidre-contenedores-vidrio): bins
  - [Papeleras](https://opendata.vlci.valencia.es/dataset/papereres-papeleras): litter bins
  - [Bancos en vía pública](https://opendata.vlci.valencia.es/dataset/bancs-en-via-publica-bancos-en-via-publica): benches
  - [Fuentes de Agua Pública](https://opendata.vlci.valencia.es/dataset/fonts-daigua-publica-fuentes-de-agua-publica): drinking fountains
  - [Bolardos extraibles](https://opendata.vlci.valencia.es/dataset/pilons-extraibles-bolardos-extraibles): bollards
  - [Aparcamientos Bicicletas](https://opendata.vlci.valencia.es/dataset/aparcaments-bicicletes-aparcamientos-bicicletas): bike racks
  - [EMT](https://opendata.vlci.valencia.es/dataset/emt): bus stops
  - [Quiosco ONCE](https://opendata.vlci.valencia.es/dataset/quiosc-once-quiosco-once): kiosks
  - [Quioscos flores](https://opendata.vlci.valencia.es/dataset/quioscs-flors-quioscos-flores): kiosks
  - [Quioscos prensa](https://opendata.vlci.valencia.es/dataset/quioscs-premsa-quioscos-prensa): kiosks
  - [Cartografía Base Toponimia](https://opendata.vlci.valencia.es/dataset/cartografia-base-toponimia-toponimia): street-name plates
  - [Ejes lineales de las calles](https://opendata.vlci.valencia.es/dataset/eixos-lineals-dels-carrers): street-name plates
  - [Portales de las calles](https://opendata.vlci.valencia.es/dataset/portals-dels-carrers-portales-de-las-calles): door numbers
  - [Manzanas catastrales con datos de población](https://opendata.vlci.valencia.es/dataset/illa-de-cases-cadastrals-amb-dades-de-poblacio): pedestrian density
  - [Barrios](https://opendata.vlci.valencia.es/dataset/barris-barrios): pedestrian density
  - [Aparcamientos por distritos-barrios](https://opendata.vlci.valencia.es/dataset/car-parks-by-districts-neighborhoods): pedestrian density

The reference photos used to calibrate the facades are from Wikimedia Commons (CC BY / CC BY-SA). They were
only used as a visual reference and are not distributed; their authors are listed in `reference/credits.json`.

## En español

València en 3D a escala real con three.js, WebGPURenderer y TSL: Ciutat Vella, el Ensanche y Russafa, el Jardí del
Túria, la Ciutat de les Arts i les Ciències, el puerto y la Malva-rosa. Los 20.028 edificios del Catastro a su altura
medida por LiDAR, los 86.267 árboles del inventario municipal y los rótulos de 6.403 comercios. Recórrela a pie, en
taxi, en bici, en patinete o en helicóptero. Es un remix de Slop Barcelona, a su vez remix de Slop New York.
**[Jugar](https://yurtarmehmet.github.io/slop-valencia/)**
