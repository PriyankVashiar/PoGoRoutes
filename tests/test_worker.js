'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const workerSource = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const cityConfigData = JSON.parse(fs.readFileSync(path.join(ROOT, 'JSON', 'cities.json'), 'utf8'));
const cityConfigs = Object.fromEntries(cityConfigData.cities.map(city => [city.cityKey, city]));

function loadWorkerContext() {
    const posted = [];
    const context = vm.createContext({
        console,
        self: {
            postMessage(value) {
                posted.push(value);
            }
        }
    });

    vm.runInContext(workerSource, context, { filename: 'worker.js' });
    return { context, posted };
}

function compactNycPoints(count) {
    const points = [];
    for (let i = 0; i < count; i++) {
        points.push({
            lat: 40.7500 + (i % 4) * 0.00045,
            lng: -73.9900 + Math.floor(i / 4) * 0.00045,
            name: `Stop ${i + 1}`
        });
    }
    return points;
}

function runWorker(context, posted, { points, isCustom = false, city = 'nyc' }) {
    posted.length = 0;
    context.self.onmessage({
        data: {
            points,
            city,
            cityConfig: cityConfigs[city].route,
            isCustom,
            timeLimitMs: 60
        }
    });
    assert.equal(posted.length, 1, 'worker should post exactly one result');
    return posted[0];
}

function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * R * Math.asin(Math.sqrt(h));
}

test('worker handles route sizes 1 through 11 without non-finite coordinates', () => {
    const { context, posted } = loadWorkerContext();

    for (let count = 1; count <= 11; count++) {
        const result = runWorker(context, posted, { points: compactNycPoints(count) });
        assert.ok(Array.isArray(result), `${count} points should return an array`);
        assert.ok(result.length > 0, `${count} points should produce a non-empty route`);

        for (const point of result) {
            assert.ok(Number.isFinite(point.lat), `${count} points: latitude must be finite`);
            assert.ok(Number.isFinite(point.lng), `${count} points: longitude must be finite`);
            assert.equal(Object.hasOwn(point, 'x'), false, 'internal x projection must not leak');
            assert.equal(Object.hasOwn(point, 'y'), false, 'internal y projection must not leak');
        }
    }
});

test('small routes are projected before TSP processing', () => {
    const { context } = loadWorkerContext();
    const grid = context.getHexGrid('nyc', cityConfigs.nyc.route);
    const projected = context.pruneOutliers(compactNycPoints(4), grid, false);

    assert.equal(projected.length, 4);
    for (const point of projected) {
        assert.ok(Number.isFinite(point.x));
        assert.ok(Number.isFinite(point.y));
    }
});

test('custom start remains route index zero', () => {
    const { context, posted } = loadWorkerContext();
    const start = { lat: 40.7484, lng: -73.9857, name: 'Start Location' };
    const result = runWorker(context, posted, {
        isCustom: true,
        points: [start, ...compactNycPoints(8)]
    });

    assert.ok(Array.isArray(result));
    assert.ok(result.length >= 2);
    assert.equal(result[0].name, start.name);
    assert.equal(result[0].lat, start.lat);
    assert.equal(result[0].lng, start.lng);
});

test('worker output never duplicates a stop', () => {
    const { context, posted } = loadWorkerContext();
    const result = runWorker(context, posted, { points: compactNycPoints(30) });
    const names = result.map(point => point.name);

    assert.equal(new Set(names).size, names.length);
});

test('custom start does not produce a start-only route when every quest is outside the geofence', () => {
    const { context, posted } = loadWorkerContext();
    const start = { lat: 40.7484, lng: -73.9857, name: 'Start Location' };
    const outsideQuest = { lat: 0, lng: 0, name: 'Outside Geofence' };

    const result = runWorker(context, posted, {
        isCustom: true,
        points: [start, outsideQuest]
    });

    assert.deepEqual(Array.from(result), []);
});

test('TSP start candidates are rebuilt after pruning shifts point indices', () => {
    const { context, posted } = loadWorkerContext();
    let capturedStartIndices = null;

    context.pruneOutliers = points => points.slice(1);
    context.solveTSP = (points, options) => {
        capturedStartIndices = Array.from(options.startIndices);
        return points;
    };
    context.pruneRouteDetours = route => route;

    const result = runWorker(context, posted, { points: compactNycPoints(12) });

    assert.equal(result.length, 11);
    assert.deepEqual(capturedStartIndices, [0, 1, 3, 5, 7, 9]);
});

test('fixed city projection stays close to haversine distance', () => {
    const { context } = loadWorkerContext();
    const grid = context.getHexGrid('nyc', cityConfigs.nyc.route);
    const a = { lat: 40.71, lng: -74.01 };
    const b = { lat: 40.81, lng: -73.91 };
    const pa = context.projectPoint(a, grid);
    const pb = context.projectPoint(b, grid);
    const projected = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const geographic = haversineMeters(a, b);
    const relativeError = Math.abs(projected - geographic) / geographic;

    assert.ok(relativeError < 0.01, `projection error ${(relativeError * 100).toFixed(3)}% should be < 1%`);
});
