# Project Agent Instructions — PoGoRoutes

> This file is the authoritative, version-controlled set of instructions for coding agents working in this repository. Read it before taking action. If instructions conflict, follow applicable higher-priority instructions and report the conflict.

---

## 1. Project Overview

- **Name:** PoGoRoutes
- **Purpose:** Automated web application and background Python scraper that extracts daily Pokémon GO Field Research quests across major cities, filters them by custom criteria, and calculates optimized GPX routes for GPS navigation.
- **Stack:** Static HTML5 / CSS3, vanilla JavaScript (ES2020+), Web Workers, Python 3; Node.js built-in test runner and Python `unittest` for regressions.
- **Platforms:** Modern desktop and mobile browsers; Python scraper on Linux/CI (GitHub Actions); GPS Joystick on Android.
- **Repository Structure:**
  - `index.html` & `style.css`: Responsive web UI with dynamic filter controls and preset management.
  - `script.js`: Frontend controller, timezone calculations, quest filtering, GPX generation, and GPS Joystick intent dispatch.
  - `worker.js`: Dedicated Web Worker running geospatial clustering, distance matrix generation, and TSP optimization.
  - `map_scraper.py`: Multi-city scraper querying live map APIs, managing rolling backups, and rebuilding master quest lists.
  - `JSON/cities.json`: Shared city configuration defining coordinates, timezones, reset windows, and route bounding boxes.
  - `JSON/Quest_List.json`: Dynamically maintained master quest dictionary used to render frontend filter options.
  - `JSON/<city>_quests.json`: City-specific quest snapshots (`nyc`, `vc`, `sg`, `syd`, `uk`).
  - `JSON/archive/`: 7-day rolling archive of city quest snapshots.
  - `tests/`: Regression test suite (`test_script.js`, `test_worker.js`, `test_map_scraper.py`, `run-tests.sh`).
  - `.github/workflows/`: Automated CI workflows for daily scraping (`run_scraper.yml`).

---

## 2. Verified System Integrations

### Codebase Memory MCP
- **Status:** Verified and active. Repository indexed with 3,000+ nodes and 3,400+ edges.
- **Dynamic Project Discovery:** Do not hardcode project identifiers across different machines. Discover the active graph project dynamically:
  1. Call `list_projects` at session start.
  2. Locate the project entry whose `root_path` matches or contains the current repository root (resolved via `git rev-parse --show-toplevel` or current working directory).
  3. Pass that entry's `name` (or the repository's absolute root path) as the `project` argument in all graph MCP calls.
- **Indexing Settings (Optional Reference):** Indexing parameters depend on host resources. As an optional reference, indexing on the baseline Linux environment succeeded with:
  ```bash
  CBM_WORKERS=1 CBM_MEM_BUDGET_MB=6144
  ```
  Adjust or omit these environment variables according to host capabilities.
- **Graph-First Exploration:** Prefer graph tools over raw file searches for structural analysis:
  - `search_graph`: Symbol lookup via pattern or query (`solveTSP`, `localSearch`).
  - `trace_path`: Inbound and outbound call tracing (e.g., verifying callers/callees of `solveTSP`).
  - `get_code_snippet`: Precise function or class source extraction with line numbers.
  - `check_index_coverage`: Validate whether candidate files have recorded issues or stale metadata.
  - `index_status`: Verify project readiness, node counts, and scan timestamps.
- **Freshness & Caveats:** Indexes do not automatically capture unstaged or out-of-band edits instantly. Check index freshness (`index_status` / `check_index_coverage`) before relying on graph results. Reindex after significant structural refactoring. Always verify critical findings against actual source files.

### Mem0 (Shared Persistent Memory)
- **Status:** Verified active across **Codex** and **Antigravity**.
- **Project Key:** `priyankvashiar-pogoroutes` *(Must use this exact project key in all agents)*.
- **Usage Rules:**
  - **Search Before Substantial Work:** Execute `search_memory(project="priyankvashiar-pogoroutes", query="...")` at the start of tasks to retrieve past architectural decisions, known pitfalls, and established constraints.
  - **Save Durable Decisions:** Use `save_memory(project="priyankvashiar-pogoroutes", content="...")` for verified technical decisions, discovered constraints, and handoff notes.
  - **Memory Hygiene:** Do not store transient debug logs, full code files, speculative hypotheses, or credentials. Avoid saving duplicate memories.
  - **Verification:** Treat retrieved memories as leads and historical context; verify them against current code before acting.

### Superpowers Framework
- **Status:** Verified available in **Codex** and **Antigravity**.
- **Usage:** Consult applicable skills for structured workflows:
  - `using-superpowers`: Foundation skill for skill discovery and invocation rules.
  - `brainstorming` & `writing-plans`: Design exploration and step-by-step implementation plans.
  - `executing-plans` & `subagent-driven-development`: Disciplined plan execution.
  - `systematic-debugging`: Root-cause investigation before applying bug fixes.
  - `test-driven-development`: Writing failing tests before code implementation.
  - `verification-before-completion`: Confirming passing checks prior to concluding work.
- **Availability Check:** Check skill availability dynamically rather than assuming every harness or subagent supports identical skills.

### GitHub Spec Kit
- **Status:** Supported for formal specification workflows.
- **Usage:** Consult `.specify/` and `specs/` when planning major new features or multi-step architecture migrations. Do not create unnecessary specification overhead for routine bug fixes or small tweaks.

---

## 3. Verified Project Architecture

```text
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  map_scraper.py  │───>│  <city>_quests   │───>│    script.js     │───>│    worker.js     │───> GPX Output /
│ (Pulls Map Data) │    │      (.json)     │    │  (Filters Items) │    │ (TSP + Pruning)  │     GPS Joystick
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
         │                                               │
         ▼                                               ▼
  JSON/cities.json                             JSON/cities.json
  (Shared Config)                              (Shared Config)
```

### Shared Configuration (`JSON/cities.json`)
- Single source of truth for city metadata shared by frontend and scraper.
- Defines for each city: `cityKey`, `name`, `url` (map endpoint), `tz` (IANA timezone), `resetHour`, `resetMinute`, default `hexSizeMeters`, and geofence coordinate `bounds` (`minLat`, `maxLat`, `minLng`, `maxLng`).

### Frontend Application Logic (`script.js`)
- **Timezone Calculations:** Uses `Intl.DateTimeFormat` for accurate regional timezone offset tracking and local midnight reset handling across daylight saving transitions.
- **Dynamic Filters:** Loads `JSON/Quest_List.json` to generate filter UI checkboxes dynamically.
- **Preset Management:** Saves and loads custom filter combinations using `localStorage`. Automatically strips obsolete or unavailable tasks upon loading without corrupting preset names or valid selections.
- **Worker Dispatch:** Packages matched coordinates (and optional user custom start anchor) and spawns `worker.js` asynchronously.
- **GPX & Deep-Link Delivery:** Serializes routes into standard GPX XML format (`<rte>` and `<rtept>`). Supports direct export to GPS Joystick on Android via `gpsjoystick://import-route` deep links, compressed with gzip (`CompressionStream`) when available or base64url encoded.

### Route Optimization Engine (`worker.js`)
Executes asynchronously on a Web Worker thread to prevent UI lockup. The pipeline proceeds as follows:
1. **Custom Start Handling:** If user start coordinates are supplied, locks them at index 0 and protects them from pruning.
2. **Geofence Bounding:** Discards quest coordinates falling outside the city's configured bounding box.
3. **Density Clustering:**
   - Primary: **Hex Binning** maps points to a flat axial coordinate grid using 32-bit packed integer keys (`getHexKey`), extracting the Largest Connected Component. Uses binary search (`hexClusterBinarySearch`) to tune the hex radius targeting 70–250 stops.
   - Fallback: Runs DBSCAN (`runDBSCANClustering`) if hex binning fails to identify a suitable cluster.
4. **Spatial Pruning (`pruneOutliers`):** Re-attaches custom start (index 0) and eliminates isolated outliers and long arms using $K$-Nearest Neighbors IQR and centroid distance thresholds.
5. **Distance Matrix & Neighbor Lists:** Precomputes an $N \times N$ `Float64Array` Euclidean distance matrix (`buildDistanceMatrix`) and pre-sorts $K$-nearest neighbor lists (`buildNeighborLists`, $K = \min(15, n - 1)$) for $O(1)$ lookups during local search.
6. **Traveling Salesperson Problem (TSP) Solver Pipeline:**
   - **`solveTSP(points, options)`**: Orchestrates two-phase route construction within a configured time budget (default 8,000 ms):
     - **Phase 1: Multi-Start Construction (40% time budget):**
       - Evaluates candidate starting vertices (`pickStartIndices`) with `nearestNeighborTSP`.
       - Evaluates a global `greedyTourConstruction` (rotated to maintain index 0 if start is fixed).
       - Refines each candidate tour using `localSearch`.
       - Tracks `bestRoute` and `bestLen`.
     - **Phase 2: Iterated Local Search (ILS, remaining 60% time budget):**
       - Applies `doubleBridgePerturb` to the best route.
       - Refines the perturbed route using `localSearch`.
       - Updates `bestRoute` whenever an improvement is found.
   - **`nearestNeighborTSP(n, matrix, startIdx)`**: Greedily constructs a tour from `startIdx` by repeatedly visiting the nearest unvisited node.
   - **`greedyTourConstruction(n, matrix)`**: Constructs a tour by sorting edges and adding the globally shortest valid edges without exceeding degree 2 or creating premature cycles (using disjoint-set `find` and `unite`).
   - **`localSearch(route, deadline, matrix, n, neighbors, k)`**: Alternates local search operators until convergence or deadline:
     - **`twoOptPass(route, matrix, n, neighbors, k)`**: 2-Opt edge uncrossing accelerated via precomputed $K$-nearest neighbor lists ($O(nK)$ instead of $O(n^2)$), invoking `reverseRange`.
     - **`orOptPass(route, segLen, matrix, n)`**: Relocates contiguous segments for **lengths 1 through 5** (`segLen = 1..5`), evaluating both forward and reversed insertions via `shiftSegmentInPlace`.
   - **`doubleBridgePerturb(route, n, fixStart)`**: 4-opt double-bridge move that breaks 4 edges and reconnects 4 sub-routes in non-sequential order to escape local minima while preserving the fixed start vertex at index 0.
7. **Detour Pruning (`pruneRouteDetours`):** Final pass over the optimized tour to drop stops with disproportionately high inclusion costs compared to average edge lengths, while strictly protecting custom start points.

### Data Ingestion & Integrity (`map_scraper.py`)
- Python scraper querying live map APIs across New York, Vancouver, Singapore, Sydney, and London.
- Writes snapshots atomically to `JSON/<city>_quests.json` via temporary files.
- Rebuilds `JSON/Quest_List.json` dynamically from saved snapshots after scrapes or resets, pruning obsolete quests.
- Tracks `city_status` (`available`, `empty`, `error`) so map failures are never misreported as valid zero-quest results.
- Retains previous city snapshots on API failures to prevent loss of master quest categories.
- Maintains a 7-day rolling archive in `JSON/archive/YYYY-MM-DD/`.

---

## 4. Standard Agent Workflow

Every agent working in this repository must follow this sequence:

1. **Read Instructions:** Read `AGENTS.md` before taking action.
2. **Check Git Status:** Run `git status --short` to detect any uncommitted edits or work in progress.
3. **Query Mem0:** Run `search_memory(project="priyankvashiar-pogoroutes", query="...")` for relevant architectural history, past bug fixes, and established constraints.
4. **Discover Project & Check Index Status:** Discover the graph project dynamically via `list_projects` matching the repository root path, then check Codebase Memory MCP status (`index_status` / `check_index_coverage`) for the files you plan to touch.
5. **Graph Code Discovery:** Use graph tools (`search_graph`, `trace_path`, `get_code_snippet`) to locate symbols and analyze call hierarchies before reading extensive files.
6. **Verify Against Source Code:** Confirm critical graph findings directly in the source files.
7. **Consult Superpowers Skills:** Check available Superpowers skills (e.g., `systematic-debugging` for bugs, `test-driven-development` for features).
8. **Implement Changes with Tests:** Make minimal, maintainable changes and add or update regression tests.
9. **Run Verification Suite:** Run the project verification commands (see [Section 5](#5-project-verification-commands)) and verify all checks pass.
10. **Save Durable Knowledge to Mem0:** Record verified architectural decisions or non-obvious fixes using `save_memory` under `project="priyankvashiar-pogoroutes"`.
11. **Update Documentation:** Update `AGENTS.md` or `README.md` if behavior, configuration, or architectural constraints changed.

> **Transparency Requirement:** If any integration (Mem0, Codebase Memory MCP, or a specific Superpowers skill) is unavailable in your environment, report that fact explicitly. Never pretend an integration was executed when it was not.

---

## 5. Project Verification Commands

All changes must pass these checks before completion.

### Linting & Syntax Checks
```bash
node --check script.js && node --check worker.js
```

### Dependency Setup (Scraper Only)
The static frontend has zero external dependencies. The scraper uses standard libraries plus `requests`:
```bash
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
```

### Local Development Server
```bash
python3 -m http.server 8000
```

### Full Regression Test Suite
Runs the unified test runner covering both JavaScript and Python suites:
```bash
./tests/run-tests.sh
```
*Current benchmark: 19 JavaScript tests and 11 Python unit tests passing (0 failures).*

### Independent Test Execution
```bash
# Frontend & Worker tests (Node.js built-in test runner)
node --test tests/test_worker.js tests/test_script.js

# Scraper tests (Python unittest without bytecode generation)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
```

---

## 6. Multi-Agent Collaboration

This repository is designed to be worked on across multiple agent harnesses:
- **Codex** *(verified in cross-agent testing)*
- **Antigravity** *(verified in cross-agent testing)*
- **Claude Code** *(reads `@AGENTS.md` via `CLAUDE.md`)*
- **GitHub Copilot** *(reads `AGENTS.md` via `.github/copilot-instructions.md`)*
- **Cursor** *(reads `AGENTS.md` via `.cursor/` configuration)*
- **Gemini CLI** *(reads `AGENTS.md` via `GEMINI.md`)*

### Collaboration Guidelines
- **Unified Memory:** All agents must use the exact project key: `priyankvashiar-pogoroutes` in Mem0.
- **Graph Knowledge:** Use Codebase Memory MCP for symbol exploration when supported by the harness.
- **Concurrency & Worktrees:** Avoid simultaneous edits to the same files. Use Git worktrees (`git worktree add ../feature-branch feature-branch`) for concurrent development branches.
- **Canonical Source of Truth:** Version-controlled files in Git (`AGENTS.md`, `README.md`, specs) are canonical. Mem0 supplements Git with cross-session context but does not replace versioned documentation.
- **Handoff Hygiene:** When concluding a session, update project docs, report test verification results, and save verified durable insights to Mem0.

---

## 7. Definition of Done

A task is complete only when:
- Requested functionality or bugfix is implemented with minimal necessary changes.
- All relevant tests (`node --check`, `./tests/run-tests.sh`) have been executed and passed.
- Relevant documentation (`AGENTS.md`, `README.md`, specs) is consistent with the code.
- Verified durable decisions are recorded in Mem0 under `priyankvashiar-pogoroutes`.
- The final response clearly outlines changed files, verification results, and any known limitations.
