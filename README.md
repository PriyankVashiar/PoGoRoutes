# 🗺️ [Pokémon GO Quest Route Generator](https://priyankvashiar.github.io/PoGoRoutes/)

An automated web application and background scraper that extracts daily Pokémon GO Field Research quests across major cities, filters them by custom criteria, and calculates optimized `.gpx` routes for GPS joystick navigation.

---

## ✨ Features

* 🎯 **Granular Quest Filtering**
  * **Items**: Poké Balls, Berries, Rare Candies, Poffins, Mega Energy, etc.
  * **Stardust**: Filter by specific stardust reward tiers.
  * **Encounters**: Filter by target Pokémon encounter rewards.
  * **Task Conditions**: Matches exact quest conditions (e.g., *"Make 3 Great Throws in a row"*).
  * **Filter Presets**: Save and load custom filter combinations using `localStorage`.

* ⚡ **High-Performance TSP & Cluster Optimization**
  * **Explicit $O(1)$ Geofence Bounds**: Fast coordinate bounding box filtering eliminates unnecessary point-in-polygon checks.
  * **Zero-Allocation Axial Hex Binning**: Maps spatial points to axial coordinates using 32-bit integer keys to eliminate string memory allocations and garbage collection pauses.
  * **Connected Component Clustering**: Retains dense, walkable PokéStop clusters by extracting the largest connected component from active hex grids.
  * **Pre-Computed Distance Matrix**: Pre-calculates an $N \times N$ `Float64Array` distance matrix for instant $O(1)$ distance lookups during local search passes.
  * **Index-Based Local Search**: Runs 2-Opt (edge uncrossing) and Or-Opt (1–3 node segment relocations) on raw `Int32Array` index arrays for fast execution.
  * **Auto-Tuning Density**: Automatically scales hex cell size to hit optimal route point counts (~70 to 250 points).

* 📍 **Custom Starting Point Support**
  * Anchor route calculations to specific user coordinates (`lat, lng`) for direct start-from-current-position routing.

* 🧵 **Non-Blocking UI**
  * All distance matrix construction, hex binning, and local search routines are offloaded to a background Web Worker (`worker.js`).

* 🤖 **Automated Scraping**
  * GitHub Actions automatically scrapes regional map data, formats payloads into standardized JSON, and updates the repository prior to local quest resets.

* 📱 **GPS Joystick Compatible**
  * Downloads standardized `.gpx` files containing `<rte>` and `<rtept>` tags, structured for direct import into GPS spoofing and routing software.
  * The `move_location` icon runs the same route generation pipeline and hands the generated GPX directly to GPS Joystick on Android using a versioned `gpsjoystick://import-route` deep-link payload. The payload is gzip-compressed when the browser supports `CompressionStream`, with a base64url fallback. Direct imports are tagged for the `Daily Quests` group in GPS Joystick.

---

## 📂 Project Structure

```text
PoGoMaps-TaskList/
├── .github/
│   └── workflows/
│       └── run_scraper.yml        # Daily automated scraper workflow
├── assets/
│   └── icons/                     # Small set of item icons (local)
├── JSON/
│   ├── archive/                   # Dated quest snapshots (scraper retention)
│   ├── cities.json                # Shared city metadata, reset times, and route bounds
│   ├── Quest_List.json
│   └── <city>_quests.json
├── index.html
├── script.js
├── worker.js                      # High-performance matrix & local search solver
├── tests/                         # Node + Python regression tests
├── map_scraper.py
└── requirements.txt
```

### Artwork (CDN)

Pokémon encounter sprites are loaded directly from the [pokemon-go-api](https://github.com/pokemon-go-api/pokemon-go-api) assets directory:

`https://raw.githubusercontent.com/pokemon-go-api/assets/main/Pokemon/pm{id}.icon.png`

Item icons are served locally under `assets/icons/`.

---

## ⚙️ How It Works

```text
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  map_scraper.py  │───>│  <city>_quests   │───>│    script.js     │───>│    worker.js     │───> Download
│ (Pulls Map Data) │    │      (.json)     │    │  (Filters Items) │    │ (TSP + Pruning)  │     (.gpx)
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
```

1. **Scrape**: `map_scraper.py` queries live map endpoints for active Pokéstops, parses active rewards/conditions, and outputs `JSON/<city_slug>_quests.json`. It also aggregates all available tasks into a global `Quest_List.json`.
2. **Select**: Users load the web UI, choose city locations, apply task/reward filters (or load saved presets), and optionally input custom start coordinates.
3. **Optimize**: Upon clicking **Generate Route**, matching points pass to `worker.js`, which:
   * Projects lat/lng to 2D planar vectors (meters) for accurate Euclidean distance calculations.
   * Identifies the dense core cluster using auto-tuning Hex Binning (Largest Connected Component), falling back to DBSCAN if needed.
   * Pre-prunes spatial outliers and isolated "arms" using KNN and centroid distances to prevent long back-and-forth detours.
   * Constructs a symmetric $N \times N$ `Float64Array` distance matrix and pre-computes $K$-nearest spatial neighbor lists.
   * Solves the Traveling Salesperson Problem (TSP) within a strict time limit using Multi-Start Nearest Neighbor, Greedy Tour construction, and Iterated Local Search (ILS) with 2-Opt (using neighbor lists), Or-Opt (1–5 node segments), and Double-Bridge perturbations.
   * Post-prunes the final route to eliminate any remaining stops with disproportionately high inclusion costs.
4. **Export / Import**: Formats the final sequence into an XML `.gpx` route file. **Generate Route** downloads the GPX normally; the `move_location` icon sends the same GPX directly to GPS Joystick on Android.

---

## 🧠 Code Logic & Architecture

### `JSON/cities.json` (Shared City Configuration)
The single source of truth for supported cities. It defines each city key, display name, map endpoint, IANA timezone, reset window, hex-grid size, and route geofence bounds. The frontend loads it to build the city selector, `script.js` passes the selected route configuration to `worker.js`, and `map_scraper.py` loads the same file for scraper endpoints.

### `map_scraper.py` (Data Ingestion)
A Python script that fetches live JSON data from external Pokémon GO map providers. It processes the raw payloads, normalizes quest conditions and rewards (items, stardust, encounters), and writes clean snapshot files (`JSON/<city>_quests.json`). It loads supported map endpoints from `JSON/cities.json` and maintains a master `Quest_List.json` that the frontend uses to dynamically generate filter checkboxes and track which cities are currently missing quests (`city_status`).

### `index.html` & `style.css` (User Interface)
A lightweight, responsive frontend that presents the available cities and dynamically loads available filters. It supports saving/loading presets to `localStorage` and includes interactive elements like custom start coordinates and real-time generation status.

### `script.js` (State Management & Filtering)
The main frontend controller. It:
- Uses `Intl.DateTimeFormat` for robust timezone calculations to safely handle regional reset windows (e.g. tracking local midnights across DST shifts).
- Fetches the `Quest_List.json` to build the UI checkboxes dynamically and dynamically lock out empty map regions.
- Fetches the specific `<city>_quests.json` when the user changes locations.
- Intercepts form submissions, collects all active filters, and quickly scans the city's quests to find matching Pokéstops.
- Sends the raw matched coordinates (and custom start point, if any) to `worker.js`.
- Receives the optimized ordered route back from the worker and formats it into a valid GPX XML structure for download.

### `worker.js` (The Routing Engine)
This Web Worker contains the heavy algorithmic logic, running on a separate thread to prevent UI freezing. Its pipeline is:
1. **Custom Start Handling**: If a custom start coordinate is provided, it is detached from the dataset to protect it from being dropped.
2. **Filtering**: Discards quest points outside the selected city's configured bounding box to remove distant noise.
3. **Clustering**: Groups quest points into density clusters. It first tries **Hex Binning** (mapping points to a flat axial coordinate grid and extracting the largest connected component). It uses binary search to find a hex size that yields a target number of stops (70–250). If hex binning fails to find a good range, it falls back to **DBSCAN**.
4. **Spatial Pruning (`pruneOutliers`)**: Re-attaches the custom start point (locked at index 0) and removes clustered points that are far from the main group (using K-Nearest Neighbors IQR and centroid distance), strictly preserving the start point.
5. **Distance Matrix**: Calculates an $O(N^2)$ Euclidean distance matrix and builds K-nearest neighbor lists.
6. **TSP Construction**: Creates initial routes using both **Multi-Start Nearest Neighbor** (starting from multiple different points, or forced to start at the custom location) and a **Greedy Tour** (always picking the globally shortest valid edge).
7. **Iterated Local Search (ILS)**: Takes the best initial routes and aggressively optimizes them until a time limit (e.g., 2000ms) is reached. If a custom start is provided, it remains strictly locked at the origin index across all operations:
   - **2-Opt**: Uncrosses intersecting edges. It uses the pre-computed neighbor lists ($O(nK)$ instead of $O(n^2)$) for massive speedups.
   - **Or-Opt**: Relocates continuous segments (1 to 5 nodes long) to better positions in the route.
   - **Double-Bridge Perturbation**: To escape local minima, it forcefully breaks 4 edges and reconnects the route in a non-sequential order, then feeds it back into 2-Opt/Or-Opt.
8. **Detour Pruning (`pruneRouteDetours`)**: A final pass over the optimized route to drop any individual stops that add excessive distance compared to the route's average edge length. The custom start point is protected from this pruning pass.

---

## 💻 Local Development

### 1. Web Application
Serve the root directory with any HTTP static file server:

```bash
# Using Python
python3 -m http.server 8000

# Using Node.js
npx serve .
```

Open `http://localhost:8000` in your web browser.

### 2. Running the Scraper Manually

```bash
# Install required Python packages
pip install -r requirements.txt

# Run scraper for a specific city (e.g., Sydney)
python map_scraper.py syd

# Run scraper for all supported cities
python map_scraper.py all
```

Dated copies are stored under `JSON/archive/YYYY-MM-DD/` (7-day retention).

### 3. Running Regression Tests

The regression suite uses only Node.js built-ins and Python's standard library in addition to the project's existing Python dependencies. It covers small-route thresholds, projection accuracy, custom-start locking, duplicate/finite worker output, zero-match handling, GPX XML generation, GPS Joystick direct-import encoding, and safe quest-condition refresh behavior.

```bash
./tests/run-tests.sh
```

You can also run each side independently:

```bash
node --test tests/test_worker.js tests/test_script.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

---

## 🚀 GitHub Actions Automation

Automated daily scraping is powered by `.github/workflows/run_scraper.yml`.

* **Schedules**: Runs automatically at staggered intervals throughout the day to mirror regional quest resets.
* **Manual Triggers**: Can be executed on demand via the **Actions** tab on GitHub using `workflow_dispatch`.

---

## 🙌 Special Thanks

* **Map Creators**: [nycpokemap.com](https://nycpokemap.com), [sgpokemap.com](https://sgpokemap.com), [sydneypogomap.com](https://sydneypogomap.com), [vanpokemap.com](https://vanpokemap.com), and [londonpogomap.com](https://londonpogomap.com) for public map endpoints.
* **[pokemon-go-api/pokemon-go-api](https://github.com/pokemon-go-api/pokemon-go-api)**: Pokémon GO specific Pokédex data structure, forms, and in-game sprites.
* **[dextel2](https://github.com/dextel2)**: Contribution to this project