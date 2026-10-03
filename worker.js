// ============================================================
// Geometric & Projection Constants
// ============================================================

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_LAT = 110540;
const METERS_PER_LNG = 111320;
const SQRT_3 = Math.sqrt(3);

const AXIAL_DIRECTIONS = [
    [1, 0], [1, -1], [0, -1],
    [-1, 0], [-1, 1], [0, 1]
];

// ============================================================
// Projection & Geofencing
// ============================================================

function projectPoint(pt, grid) {
    const refLatRad = grid.refLat * DEG_TO_RAD;
    const { x, y } = hexProject(pt.lat, pt.lng, grid.origin, refLatRad);
    return { ...pt, x, y };
}

function filterPoints(points, grid) {
    if (!grid || !grid.bounds) return points;
    const { minLat, maxLat, minLng, maxLng } = grid.bounds;
    return points.filter(pt =>
        pt.lat >= minLat && pt.lat <= maxLat && pt.lng >= minLng && pt.lng <= maxLng
    );
}

// ============================================================
// City Route Configuration & Hex Grid
// ============================================================

function getHexGrid(cityKey, config) {
    const bounds = config?.bounds;
    const requiredNumbers = [
        config?.hexSizeMeters,
        bounds?.minLat, bounds?.maxLat,
        bounds?.minLng, bounds?.maxLng
    ];

    if (!config || !bounds || requiredNumbers.some(value => !Number.isFinite(value))) {
        throw new Error(`Invalid or missing route config for "${cityKey}".`);
    }

    return {
        hexSizeMeters: config.hexSizeMeters,
        origin: { lat: bounds.minLat, lng: bounds.minLng },
        refLat: (bounds.minLat + bounds.maxLat) / 2,
        bounds: { ...bounds }
    };
}

// ============================================================
// Hex Grid Math
// ============================================================

function hexProject(lat, lng, origin, refLatRad) {
    return {
        x: (lng - origin.lng) * METERS_PER_LNG * Math.cos(refLatRad),
        y: (lat - origin.lat) * METERS_PER_LAT
    };
}

function pixelToAxialFrac(x, y, size) {
    return {
        q: (2 / 3) * x / size,
        r: ((-1 / 3) * x + (SQRT_3 / 3) * y) / size
    };
}

function axialRound(qFrac, rFrac) {
    let rx = Math.round(qFrac);
    let rz = Math.round(rFrac);
    const ry = Math.round(-qFrac - rFrac);
    const xDiff = Math.abs(rx - qFrac);
    const yDiff = Math.abs(ry - (-qFrac - rFrac));
    const zDiff = Math.abs(rz - rFrac);
    if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
    else if (yDiff <= zDiff) rz = -rx - ry;
    return { q: rx, r: rz };
}

// Maps axial (q, r) to a unique 32-bit integer key — zero string allocations
function getHexKey(q, r) {
    return ((q + 32768) << 16) | ((r + 32768) & 0xFFFF);
}

function binPointsToHexagons(points, grid) {
    const origin = grid.origin;
    const refLatRad = grid.refLat * DEG_TO_RAD;
    const size = grid.hexSizeMeters;
    const map = new Map();
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const { x, y } = hexProject(pt.lat, pt.lng, origin, refLatRad);
        const frac = pixelToAxialFrac(x, y, size);
        const { q, r } = axialRound(frac.q, frac.r);
        const id = getHexKey(q, r);
        let entry = map.get(id);
        if (!entry) {
            entry = { q, r, points: [] };
            map.set(id, entry);
        }
        entry.points.push(pt);
    }
    return map;
}

function pickDeterministicHexPoint(pts) {
    if (pts.length === 1) return 0;
    let sumLat = 0, sumLng = 0;
    for (let i = 0; i < pts.length; i++) {
        sumLat += pts[i].lat;
        sumLng += pts[i].lng;
    }
    const cLat = sumLat / pts.length;
    const cLng = sumLng / pts.length;
    let bestIdx = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const dLat = pts[i].lat - cLat;
        const dLng = pts[i].lng - cLng;
        const d = dLat * dLat + dLng * dLng;
        if (d < bestD) { bestD = d; bestIdx = i; }
    }
    return bestIdx;
}

// ============================================================
// Adaptive Density Thresholds
// ============================================================
// Derives minPointsPerHex and minActiveNeighbors from the
// median hex density instead of using hardcoded values.
// Sparse cities (London) get lower thresholds; dense cities
// (Singapore) get higher ones.

function computeAdaptiveThresholds(hexMap) {
    const counts = [];
    for (const entry of hexMap.values()) {
        counts.push(entry.points.length);
    }
    if (counts.length === 0) return { minPointsPerHex: 3, minActiveNeighbors: 2 };

    counts.sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)];

    return {
        minPointsPerHex: Math.max(2, Math.floor(median * 0.3)),
        minActiveNeighbors: median > 5 ? 2 : 1
    };
}

// ============================================================
// Hex Filtering & Connected Components
// ============================================================

function filterActiveHexagons(hexMap, minPoints, minActiveNeighbors) {
    const activeIds = new Set();
    for (const [id, entry] of hexMap.entries()) {
        if (entry.points.length >= minPoints) activeIds.add(id);
    }
    const filtered = new Set();
    for (const id of activeIds) {
        const entry = hexMap.get(id);
        let count = 0;
        for (let i = 0; i < 6; i++) {
            const [dq, dr] = AXIAL_DIRECTIONS[i];
            if (activeIds.has(getHexKey(entry.q + dq, entry.r + dr))) count++;
        }
        if (count >= minActiveNeighbors) filtered.add(id);
    }
    return filtered;
}

function filterLargestConnectedComponent(activeIds, hexMap) {
    if (activeIds.size <= 1) return activeIds;
    const visited = new Set();
    let largestComponent = new Set();
    const ids = [...activeIds].sort((a, b) => a - b);
    for (const id of ids) {
        if (visited.has(id)) continue;
        const comp = new Set();
        const queue = [id];
        let head = 0;
        visited.add(id);
        while (head < queue.length) {
            const curr = queue[head++];
            comp.add(curr);
            const entry = hexMap.get(curr);
            if (!entry) continue;
            for (let i = 0; i < 6; i++) {
                const [dq, dr] = AXIAL_DIRECTIONS[i];
                const nid = getHexKey(entry.q + dq, entry.r + dr);
                if (activeIds.has(nid) && !visited.has(nid)) {
                    visited.add(nid);
                    queue.push(nid);
                }
            }
        }
        if (comp.size > largestComponent.size) largestComponent = comp;
    }
    return largestComponent;
}

// ============================================================
// Hex Clustering Pipeline
// ============================================================

function runHexClustering(rawPoints, baseGrid, hexSize) {
    const grid = { ...baseGrid, hexSizeMeters: hexSize };
    const hexMap = binPointsToHexagons(rawPoints, grid);

    const { minPointsPerHex, minActiveNeighbors } = computeAdaptiveThresholds(hexMap);
    const activeHexIds = filterActiveHexagons(hexMap, minPointsPerHex, minActiveNeighbors);
    const connectedHexIds = filterLargestConnectedComponent(activeHexIds, hexMap);

    const targetPoints = [];
    const startIndices = [];
    const sortedHexIds = [...connectedHexIds].sort((a, b) => a - b);

    for (const hexId of sortedHexIds) {
        const entry = hexMap.get(hexId);
        if (!entry || entry.points.length === 0) continue;
        const pickIdx = pickDeterministicHexPoint(entry.points);
        startIndices.push(targetPoints.length + pickIdx);
        targetPoints.push(...entry.points);
    }

    return { points: targetPoints, startIndices };
}

// ============================================================
// Binary Search Hex Size Tuning
// ============================================================
// Replaces the linear +200/−100 step loop with binary search,
// converging in ≤8 iterations instead of potentially many.

function hexClusterBinarySearch(rawPoints, baseGrid) {
    const defaultSize = baseGrid.hexSizeMeters;

    // Try the city default first
    let bestResult = runHexClustering(rawPoints, baseGrid, defaultSize);
    let bestCount = bestResult.points.length;

    if (bestCount >= 70 && bestCount <= 250) return bestResult;

    let lo = Math.max(100, defaultSize - 600);
    let hi = defaultSize + 1000;
    const visited = new Set([defaultSize]);

    for (let iter = 0; iter < 8; iter++) {
        const mid = Math.round((lo + hi) / 2);
        if (visited.has(mid) || hi - lo < 50) break;
        visited.add(mid);

        const result = runHexClustering(rawPoints, baseGrid, mid);
        const count = result.points.length;

        const inRange = count >= 70 && count <= 250;

        if (inRange && count > bestCount) {
            bestResult = result;
            bestCount = count;
        } else if (!inRange && count > 0) {
            const bestDist = bestCount < 70 ? 70 - bestCount : bestCount - 250;
            const currDist = count < 70 ? 70 - count : count - 250;
            if (currDist < bestDist) {
                bestResult = result;
                bestCount = count;
            }
        }

        if (count < 70) lo = mid;
        else if (count > 250) hi = mid;
        else break; // sweet spot
    }

    return bestResult;
}

// ============================================================
// Outlier Pruning — Pre-TSP
// ============================================================
// Two-pass spatial filter:
//   Pass 1: KNN-IQR — removes individual outliers whose average
//     distance to K nearest neighbors is statistically extreme.
//   Pass 2: Centroid radius — removes points far from the spatial
//     median of the remaining cluster. This catches "arms" (chains
//     of stops extending from the core) that KNN misses because
//     each arm point has close neighbors along the arm itself.

function pruneOutliers(points, grid, preserveFirst = false) {
    const MIN_POINTS = 10;

    // Project every point into the same local coordinate system. Using a fixed
    // reference latitude and origin avoids distorting distances by applying a
    // different longitude scale to each point.
    const proj = points.map(p => projectPoint(p, grid));
    if (proj.length <= MIN_POINTS) return proj;
    const n = proj.length;
    const K = Math.min(7, n - 1);

    // --- Pass 1: KNN-IQR outlier removal ---
    const avgKnn = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const dists = new Float64Array(n - 1);
        let di = 0;
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const dx = proj[i].x - proj[j].x;
            const dy = proj[i].y - proj[j].y;
            dists[di++] = Math.sqrt(dx * dx + dy * dy);
        }
        dists.sort();
        let sum = 0;
        for (let m = 0; m < K; m++) sum += dists[m];
        avgKnn[i] = sum / K;
    }

    const sorted1 = Float64Array.from(avgKnn).sort();
    const q1 = sorted1[Math.floor(n * 0.25)];
    const q3 = sorted1[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    const knnThreshold = q3 + 1.5 * iqr;

    let pass1 = [];
    for (let i = 0; i < n; i++) {
        if ((preserveFirst && i === 0) || avgKnn[i] <= knnThreshold) {
            pass1.push(proj[i]); // keep projected points (x/y already present)
        }
    }
    if (pass1.length <= MIN_POINTS) pass1 = proj.slice();

    // --- Pass 2: Centroid-radius pruning ---
    // Compute spatial median (componentwise median — robust to outliers)
    const n2 = pass1.length;

    const xs = pass1.map(p => p.x).sort((a, b) => a - b);
    const ys = pass1.map(p => p.y).sort((a, b) => a - b);
    const medX = xs[Math.floor(n2 / 2)];
    const medY = ys[Math.floor(n2 / 2)];

    // Compute distances from spatial median
    const centroidDists = new Float64Array(n2);
    for (let i = 0; i < n2; i++) {
        const dx = pass1[i].x - medX;
        const dy = pass1[i].y - medY;
        centroidDists[i] = Math.sqrt(dx * dx + dy * dy);
    }

    // Use 90th percentile as cutoff — keeps the dense core, trims the periphery
    const sorted2 = Float64Array.from(centroidDists).sort();
    const p90 = sorted2[Math.floor(n2 * 0.90)];
    const radiusThreshold = p90 * 1.3;

    let pass2 = [];
    for (let i = 0; i < n2; i++) {
        if ((preserveFirst && i === 0) || centroidDists[i] <= radiusThreshold) {
            pass2.push(pass1[i]);
        }
    }
    if (pass2.length <= MIN_POINTS) return pass1;
    return pass2;
}

// ============================================================
// Detour Pruning — Post-TSP
// ============================================================
// After the TSP route is built, iteratively remove the stop with
// the highest "detour cost" (distance to visit it and come back)
// if it exceeds a threshold relative to the typical edge length.
// This catches stragglers that cause long spikes in the route.

function pruneRouteDetours(route, preserveFirst = false) {
    if (route.length <= 15) return route;

    const result = [...route];
    const MAX_REMOVALS = Math.max(3, Math.floor(route.length * 0.12));
    let removals = 0;

    while (result.length > 15 && removals < MAX_REMOVALS) {
        // Compute edge lengths
        const edges = new Float64Array(result.length - 1);
        for (let i = 0; i < result.length - 1; i++) {
            const dx = result[i].x - result[i + 1].x;
            const dy = result[i].y - result[i + 1].y;
            edges[i] = Math.sqrt(dx * dx + dy * dy);
        }

        // Median edge length
        const sortedEdges = Float64Array.from(edges).sort();
        const medianEdge = sortedEdges[Math.floor(sortedEdges.length / 2)];
        if (medianEdge === 0) break;
        const detourThreshold = medianEdge * 4.0;

        // Find the stop with the worst detour cost
        let worstIdx = -1, worstCost = 0;
        for (let i = 1; i < result.length - 1; i++) {
            // Detour cost = dist(prev, i) + dist(i, next) - dist(prev, next)
            const dx = result[i - 1].x - result[i + 1].x;
            const dy = result[i - 1].y - result[i + 1].y;
            const direct = Math.sqrt(dx * dx + dy * dy);
            const detour = edges[i - 1] + edges[i] - direct;
            if (detour > worstCost) {
                worstCost = detour;
                worstIdx = i;
            }
        }

        // Also check the last point (route endpoint)
        const lastIdx = result.length - 1;
        const endDetour = edges[lastIdx - 1] * 2; // out and back
        if (endDetour > worstCost) {
            worstCost = endDetour;
            worstIdx = lastIdx;
        }

        if (worstIdx === -1 || worstCost <= detourThreshold) break;

        result.splice(worstIdx, 1);
        removals++;
    }

    return result;
}

// ============================================================
// DBSCAN Clustering
// ============================================================
// Finds arbitrarily-shaped dense clusters that hex grids miss
// (e.g. PokéStop lines along streets, diagonal clusters split
// by hex boundaries). Runs alongside hex clustering; the better
// result is selected.

function dbscanRegionQuery(points, idx, eps2) {
    const neighbors = [];
    const px = points[idx].x, py = points[idx].y;
    for (let i = 0; i < points.length; i++) {
        if (i === idx) continue;
        const dx = points[i].x - px;
        const dy = points[i].y - py;
        if (dx * dx + dy * dy <= eps2) neighbors.push(i);
    }
    return neighbors;
}

function dbscan(projectedPoints, eps, minPts) {
    const n = projectedPoints.length;
    const labels = new Int32Array(n).fill(-1); // -1 = unvisited
    const NOISE = -2;
    let clusterId = 0;
    const eps2 = eps * eps;

    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;

        const neighbors = dbscanRegionQuery(projectedPoints, i, eps2);
        if (neighbors.length < minPts) {
            labels[i] = NOISE;
            continue;
        }

        // New cluster — expand from core point i
        labels[i] = clusterId;
        const seeds = [...neighbors];
        let seedIdx = 0;

        while (seedIdx < seeds.length) {
            const q = seeds[seedIdx++];

            // Claim noise points as border members (no expansion)
            if (labels[q] === NOISE) { labels[q] = clusterId; continue; }
            // Skip already-processed points
            if (labels[q] !== -1) continue;

            labels[q] = clusterId;
            const qNeighbors = dbscanRegionQuery(projectedPoints, q, eps2);
            if (qNeighbors.length >= minPts) {
                for (const nb of qNeighbors) {
                    if (labels[nb] === -1 || labels[nb] === NOISE) seeds.push(nb);
                }
            }
        }

        clusterId++;
    }

    return { labels, numClusters: clusterId };
}

function runDBSCANClustering(rawPoints, grid) {
    const projected = rawPoints.map(p => projectPoint(p, grid));
    const eps = grid.hexSizeMeters;
    const minPts = 3; // need ≥3 other points within eps to be a core point

    const { labels, numClusters } = dbscan(projected, eps, minPts);
    if (numClusters === 0) return { points: [], startIndices: [0] };

    // Find the largest cluster
    const counts = new Int32Array(numClusters);
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] >= 0) counts[labels[i]]++;
    }
    let bestClusterId = 0;
    for (let i = 1; i < numClusters; i++) {
        if (counts[i] > counts[bestClusterId]) bestClusterId = i;
    }

    const clusterPoints = [];
    for (let i = 0; i < rawPoints.length; i++) {
        if (labels[i] === bestClusterId) clusterPoints.push(rawPoints[i]);
    }

    // Diverse start indices for multi-start NN
    const startIndices = pickStartIndices(clusterPoints.length, Math.min(6, clusterPoints.length));

    return { points: clusterPoints, startIndices };
}

// ============================================================
// Distance Matrix & K-Nearest Neighbor Lists
// ============================================================

function buildDistanceMatrix(points) {
    const n = points.length;
    const matrix = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        const pi = points[i];
        const iOffset = i * n;
        for (let j = i + 1; j < n; j++) {
            const pj = points[j];
            const dx = pi.x - pj.x;
            const dy = pi.y - pj.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            matrix[iOffset + j] = d;
            matrix[j * n + i] = d;
        }
    }
    return matrix;
}

// Pre-compute K closest neighbors per point. During 2-opt, only
// these neighbors are checked — drops per-pass cost from O(n²)
// to O(nK) while rarely missing improving moves.
function buildNeighborLists(n, matrix, k) {
    k = Math.min(k, n - 1);
    const neighbors = new Array(n);

    for (let i = 0; i < n; i++) {
        const rowOffset = i * n;
        const indices = new Array(n - 1);
        for (let j = 0, idx = 0; j < n; j++) {
            if (j !== i) indices[idx++] = j;
        }
        indices.sort((a, b) => matrix[rowOffset + a] - matrix[rowOffset + b]);

        const list = new Int32Array(k);
        for (let j = 0; j < k; j++) list[j] = indices[j];
        neighbors[i] = list;
    }

    return neighbors;
}

// ============================================================
// Tour Construction: Nearest Neighbor
// ============================================================

function nearestNeighborTSP(n, matrix, startIdx = 0) {
    const route = new Int32Array(n);
    const visited = new Uint8Array(n);
    route[0] = startIdx;
    visited[startIdx] = 1;
    let current = startIdx;
    for (let count = 1; count < n; count++) {
        const rowOffset = current * n;
        let bestIdx = -1, minDist = Infinity;
        for (let i = 0; i < n; i++) {
            if (!visited[i]) {
                const d = matrix[rowOffset + i];
                if (d < minDist) { minDist = d; bestIdx = i; }
            }
        }
        visited[bestIdx] = 1;
        route[count] = bestIdx;
        current = bestIdx;
    }
    return route;
}

// ============================================================
// Tour Construction: Greedy (shortest-edge-first)
// ============================================================
// Builds a Hamiltonian path by greedily adding the shortest
// available edge that doesn't create degree > 2 or a premature
// cycle. Produces structurally different tours from NN,
// giving ILS more diverse starting material.

function greedyTourConstruction(n, matrix) {

    const numEdges = (n * (n - 1)) >> 1;
    const edgeU = new Int32Array(numEdges);
    const edgeV = new Int32Array(numEdges);
    const edgeDist = new Float64Array(numEdges);
    const edgeOrder = new Array(numEdges);
    let ei = 0;
    for (let i = 0; i < n; i++) {
        const rowOffset = i * n;
        for (let j = i + 1; j < n; j++) {
            edgeU[ei] = i;
            edgeV[ei] = j;
            edgeDist[ei] = matrix[rowOffset + j];
            edgeOrder[ei] = ei;
            ei++;
        }
    }
    edgeOrder.sort((a, b) => edgeDist[a] - edgeDist[b]);

    // Union-Find for cycle detection
    const parent = new Int32Array(n);
    const ufRank = new Uint8Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    function find(x) {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
    function unite(x, y) {
        const rx = find(x), ry = find(y);
        if (rx === ry) return false;
        if (ufRank[rx] < ufRank[ry]) parent[rx] = ry;
        else if (ufRank[rx] > ufRank[ry]) parent[ry] = rx;
        else { parent[ry] = rx; ufRank[rx]++; }
        return true;
    }

    const degree = new Uint8Array(n);
    const adj = new Array(n);
    for (let i = 0; i < n; i++) adj[i] = [];
    let edgeCount = 0;

    for (let idx = 0; idx < numEdges && edgeCount < n - 1; idx++) {
        const e = edgeOrder[idx];
        const u = edgeU[e], v = edgeV[e];
        if (degree[u] >= 2 || degree[v] >= 2) continue;
        if (find(u) === find(v)) continue; // would create cycle
        unite(u, v);
        degree[u]++;
        degree[v]++;
        adj[u].push(v);
        adj[v].push(u);
        edgeCount++;
    }

    // Walk the path from an endpoint (degree ≤ 1)
    let start = 0;
    for (let i = 0; i < n; i++) {
        if (degree[i] <= 1) { start = i; break; }
    }

    const route = new Int32Array(n);
    const visited = new Uint8Array(n);
    route[0] = start;
    visited[start] = 1;
    let current = start;

    for (let step = 1; step < n; step++) {
        let next = -1;
        for (const nb of adj[current]) {
            if (!visited[nb]) { next = nb; break; }
        }
        if (next === -1) {
            // Disconnected fragment — bridge to nearest unvisited
            let bestDist = Infinity;
            const rowOffset = current * n;
            for (let i = 0; i < n; i++) {
                if (!visited[i] && matrix[rowOffset + i] < bestDist) {
                    bestDist = matrix[rowOffset + i];
                    next = i;
                }
            }
        }
        if (next === -1) break;
        route[step] = next;
        visited[next] = 1;
        current = next;
    }

    return route;
}

// ============================================================
// Local Search Primitives
// ============================================================

function routeLength(route, matrix, n) {
    let total = 0;
    for (let i = 0; i < n - 1; i++) {
        total += matrix[route[i] * n + route[i + 1]];
    }
    return total;
}

function reverseRange(arr, i, j) {
    while (i < j) {
        const temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
        i++; j--;
    }
}

// --- Unified 2-Opt (always uses neighbor lists) ---
// Building neighbor lists for n ≤ 100 takes < 0.1ms, so there's
// no benefit to maintaining a separate O(n²) path.
function twoOptPass(route, matrix, n, neighbors, k) {
    // Position lookup: posOf[pointIdx] = route position
    const posOf = new Int32Array(n);
    for (let i = 0; i < n; i++) posOf[route[i]] = i;

    let improved = false;

    for (let pos = 1; pos < n - 1; pos++) {
        const u = route[pos];
        const prevU = route[pos - 1];
        const d_prev_u = matrix[prevU * n + u];
        const nbrList = neighbors[u];

        for (let ki = 0; ki < k; ki++) {
            const v = nbrList[ki];
            const vPos = posOf[v];

            if (vPos <= pos || vPos - pos <= 1) continue;

            let delta;
            if (vPos + 1 < n) {
                const nextV = route[vPos + 1];
                delta = (matrix[prevU * n + v] + matrix[u * n + nextV])
                      - (d_prev_u + matrix[v * n + nextV]);
            } else {
                delta = matrix[prevU * n + v] - d_prev_u;
            }

            if (delta < -1e-9) {
                reverseRange(route, pos, vPos);
                for (let r = pos; r <= vPos; r++) posOf[route[r]] = r;
                improved = true;
                break; // re-scan from next pos
            }
        }
    }

    return improved;
}

// --- Or-Opt (segment relocation, sizes 1–5) ---
let segBuffer = new Int32Array(10);

function shiftSegmentInPlace(route, i, segLen, insertAt, reverse) {
    for (let k = 0; k < segLen; k++) segBuffer[k] = route[i + k];
    if (reverse) {
        let left = 0, right = segLen - 1;
        while (left < right) {
            const tmp = segBuffer[left];
            segBuffer[left] = segBuffer[right];
            segBuffer[right] = tmp;
            left++; right--;
        }
    }
    if (insertAt < i) {
        for (let k = i - 1; k >= insertAt; k--) route[k + segLen] = route[k];
        for (let k = 0; k < segLen; k++) route[insertAt + k] = segBuffer[k];
    } else {
        const shiftCount = insertAt - (i + segLen);
        for (let k = 0; k < shiftCount; k++) route[i + k] = route[i + segLen + k];
        const targetStart = i + shiftCount;
        for (let k = 0; k < segLen; k++) route[targetStart + k] = segBuffer[k];
    }
}

function orOptPass(route, segLen, matrix, n) {
    if (n <= segLen + 2) return false;
    for (let i = 1; i <= n - segLen - 1; i++) {
        const prev = route[i - 1];
        const segStart = route[i];
        const segEnd = route[i + segLen - 1];
        const next = route[i + segLen];
        const removeCost = matrix[prev * n + segStart]
                         + matrix[segEnd * n + next]
                         - matrix[prev * n + next];
        if (removeCost <= 1e-9) continue;
        for (let j = 0; j < n - 1; j++) {
            if (j >= i - 1 && j <= i + segLen - 1) continue;
            const a = route[j], b = route[j + 1];
            const insertFwd = matrix[a * n + segStart] + matrix[segEnd * n + b] - matrix[a * n + b];
            // When segLen===1, segStart===segEnd so insertFwd===insertRev (symmetric)
            const reversed = segLen > 1 && (matrix[a * n + segEnd] + matrix[segStart * n + b] - matrix[a * n + b]) < insertFwd;
            const insertCost = reversed ? (matrix[a * n + segEnd] + matrix[segStart * n + b] - matrix[a * n + b]) : insertFwd;
            if (insertCost - removeCost < -1e-9) {
                shiftSegmentInPlace(route, i, segLen, j + 1, reversed);
                return true;
            }
        }
    }
    return false;
}

// Combined local search: 2-Opt + Or-Opt (segments 1–5)
function localSearch(route, deadline, matrix, n, neighbors, k) {
    let improved = true;
    let checkCounter = 0;
    while (improved) {
        improved = false;
        if (twoOptPass(route, matrix, n, neighbors, k)) improved = true;
        if ((++checkCounter & 3) === 0 && Date.now() > deadline) break;
        for (let segLen = 1; segLen <= 5; segLen++) {
            if ((++checkCounter & 3) === 0 && Date.now() > deadline) break;
            if (orOptPass(route, segLen, matrix, n)) improved = true;
        }
    }
    return route;
}

// ============================================================
// Double-Bridge Perturbation
// ============================================================
// A random 4-edge break that reconnects four segments in a
// non-sequential order (A-C-B-D). This move CANNOT be reversed
// by any sequence of 2-opt or or-opt moves, so it escapes
// local optima that plain local search gets stuck in.

let perturbBuffer = null;

function doubleBridgePerturb(route, n, fixStart) {
    const lo = fixStart ? 1 : 0;
    const len = n - lo;

    if (!perturbBuffer || perturbBuffer.length !== n) {
        perturbBuffer = new Int32Array(n);
    }

    if (len < 8) {
        perturbBuffer.set(route);
        return perturbBuffer;
    }

    // Pick 3 unique cut positions in (lo, n)
    const cuts = new Set();
    while (cuts.size < 3) {
        cuts.add(lo + 1 + Math.floor(Math.random() * (len - 1)));
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const [c1, c2, c3] = sorted;

    // Reconnect: A=[0,c1) + C=[c2,c3) + B=[c1,c2) + D=[c3,n)
    let pos = 0;
    for (let i = 0; i < c1; i++) perturbBuffer[pos++] = route[i];
    for (let i = c2; i < c3; i++) perturbBuffer[pos++] = route[i];
    for (let i = c1; i < c2; i++) perturbBuffer[pos++] = route[i];
    for (let i = c3; i < n; i++) perturbBuffer[pos++] = route[i];

    return perturbBuffer;
}

// ============================================================
// Main TSP Solver — Multi-Start + ILS
// ============================================================
// Phase 1 (40% budget): Build initial tours from multiple NN
//   starts plus one greedy construction, run local search on each.
// Phase 2 (60% budget): Iterated Local Search — perturb the
//   best tour with double-bridge, re-optimize, keep if better.

function pickStartIndices(n, count) {
    const starts = new Set();
    for (let i = 0; i < count; i++) {
        starts.add(Math.floor((i * n) / count));
    }
    return [...starts];
}

function solveTSP(points, options = {}) {
    const n = points.length;
    if (n <= 3) return [...points];

    const timeLimitMs = options.timeLimitMs || 8000;
    const fixStart = options.fixStart || false;
    const overallDeadline = Date.now() + timeLimitMs;

    const matrix = buildDistanceMatrix(points);
    const NEIGHBOR_K = Math.min(15, n - 1);
    const neighbors = buildNeighborLists(n, matrix, NEIGHBOR_K);

    // --- Phase 1: Multi-start construction (40% of budget) ---
    const phase1Deadline = Date.now() + Math.floor(timeLimitMs * 0.4);

    const startIndices = options.startIndices;

    let bestRoute = null;
    let bestLen = Infinity;

    // Nearest-Neighbor starts
    for (let s = 0; s < startIndices.length; s++) {
        if (Date.now() > phase1Deadline) break;

        let route = nearestNeighborTSP(n, matrix, startIndices[s]);
        const remaining = phase1Deadline - Date.now();
        const perStartBudget = Math.max(remaining / (startIndices.length - s + 1), 100);
        const deadline = Date.now() + perStartBudget;

        route = localSearch(route, Math.min(deadline, phase1Deadline), matrix, n, neighbors, NEIGHBOR_K);

        const len = routeLength(route, matrix, n);
        if (len < bestLen) {
            bestLen = len;
            bestRoute = new Int32Array(route);
        }
    }

    // Greedy tour start
    if (Date.now() < phase1Deadline) {
        let greedyRoute = greedyTourConstruction(n, matrix);

        // If custom start is required, rotate so index 0 is at position 0
        if (fixStart && greedyRoute[0] !== 0) {
            let zeroPos = 0;
            for (let i = 1; i < n; i++) {
                if (greedyRoute[i] === 0) { zeroPos = i; break; }
            }
            const rotated = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                rotated[i] = greedyRoute[(i + zeroPos) % n];
            }
            greedyRoute = rotated;
        }

        const greedyDeadline = Math.min(Date.now() + 300, phase1Deadline);
        greedyRoute = localSearch(greedyRoute, greedyDeadline, matrix, n, neighbors, NEIGHBOR_K);

        const greedyLen = routeLength(greedyRoute, matrix, n);
        if (greedyLen < bestLen) {
            bestLen = greedyLen;
            bestRoute = new Int32Array(greedyRoute);
        }
    }

    // --- Phase 2: Iterated Local Search (remaining 60%) ---
    const ilsDeadline = overallDeadline - 20; // 20 ms safety margin
    while (Date.now() < ilsDeadline) {
        const perturbed = doubleBridgePerturb(bestRoute, n, fixStart);
        const optimized = localSearch(perturbed, ilsDeadline, matrix, n, neighbors, NEIGHBOR_K);
        const len = routeLength(optimized, matrix, n);
        if (len < bestLen) {
            bestLen = len;
            bestRoute = new Int32Array(optimized);
        }
    }

    // Map index route back to point objects
    const result = new Array(n);
    for (let i = 0; i < n; i++) result[i] = points[bestRoute[i]];
    return result;
}

// ============================================================
// Worker Message Handler
// ============================================================

self.onmessage = function (e) {
    const rawPointsIn = e.data.points || e.data || [];
    const cityKey = e.data.city || "unknown";
    const cityConfig = e.data.cityConfig;
    const timeLimitMs = e.data.timeLimitMs || 8000;
    const isCustom = e.data.isCustom || false;

    // --- Geofence & Setup ---
    let baseGrid;
    try {
        baseGrid = getHexGrid(cityKey, cityConfig);
    } catch (err) {
        self.postMessage({ error: err.message });
        return;
    }

    let startPoint = null;
    let questPoints = rawPointsIn;

    if (isCustom) {
        startPoint = rawPointsIn[0];
        questPoints = rawPointsIn.slice(1);
    }

    // Filter quest points by bounding box
    questPoints = filterPoints(questPoints, baseGrid);

    if (questPoints.length === 0) {
        // A custom start is only meaningful when at least one quest destination
        // survives the city geofence. Never emit a start-only route.
        self.postMessage([]);
        return;
    }

    // --- Clustering ---
    let clusteredPoints = [];
    let candidateStartIndices = [];

    if (questPoints.length <= 70) {
        // Too few to cluster — use everything
        clusteredPoints = questPoints;
        candidateStartIndices = [0];
    } else {
        // Strategy 1: Hex-based clustering (binary-search tuned)
        const hexResult = hexClusterBinarySearch(questPoints, baseGrid);
        const hexCount = hexResult.points.length;
        const hexInRange = hexCount >= 70 && hexCount <= 250;

        // Strategy 2: DBSCAN — only run if hex clustering didn't produce an in-range result
        if (hexInRange) {
            clusteredPoints = hexResult.points;
            candidateStartIndices = hexResult.startIndices;
        } else {
            const dbscanResult = runDBSCANClustering(questPoints, baseGrid);
            const dbCount = dbscanResult.points.length;
            const dbInRange = dbCount >= 70 && dbCount <= 250;

            if (dbInRange && dbCount > hexCount) {
                clusteredPoints = dbscanResult.points;
                candidateStartIndices = dbscanResult.startIndices;
            } else if (hexCount > 0) {
                clusteredPoints = hexResult.points;
                candidateStartIndices = hexResult.startIndices;
            } else if (dbCount > 0) {
                clusteredPoints = dbscanResult.points;
                candidateStartIndices = dbscanResult.startIndices;
            } else {
                clusteredPoints = questPoints;
                candidateStartIndices = [0];
            }
        }
    }

    // Combine custom start point back if applicable
    let targetPoints = clusteredPoints;
    if (isCustom) {
        targetPoints = [startPoint, ...clusteredPoints];
        candidateStartIndices = [0]; // Force TSP to start at index 0
    }

    // --- Pre-TSP: Spatial outlier pruning ---
    // Returns points projected with the city's fixed origin/reference latitude.
    targetPoints = pruneOutliers(targetPoints, baseGrid, isCustom);

    if (targetPoints.length === 0) {
        self.postMessage([]);
        return;
    }

    // Pruning can remove points from anywhere in the array, shifting every later
    // index. Rebuild candidates from the post-pruning array rather than carrying
    // stale clustering indices into the TSP solver.
    if (isCustom) {
        candidateStartIndices = [0];
    } else {
        candidateStartIndices = pickStartIndices(
            targetPoints.length,
            Math.min(6, targetPoints.length)
        );
    }

    // --- Solve TSP ---
    // Points already projected by pruneOutliers, pass directly
    const route = solveTSP(targetPoints, {
        startIndices: candidateStartIndices,
        timeLimitMs,
        fixStart: isCustom
    });

    // --- Post-TSP: Detour pruning ---
    const prunedRoute = pruneRouteDetours(route, isCustom);

    // Strip internal projection fields
    for (let i = 0; i < prunedRoute.length; i++) {
        delete prunedRoute[i].x;
        delete prunedRoute[i].y;
    }

    self.postMessage(prunedRoute);
};