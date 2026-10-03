'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { TextEncoder } = require('node:util');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const scriptSource = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const cityConfigData = JSON.parse(fs.readFileSync(path.join(ROOT, 'JSON', 'cities.json'), 'utf8'));
const cityConfigs = Object.fromEntries(cityConfigData.cities.map(city => [city.cityKey, city]));

function makeContext() {
    const document = {
        readyState: 'loading',
        addEventListener() {},
        getElementById() { return null; },
        querySelectorAll() { return []; },
        createElement() { return {}; },
        createTextNode(value) { return { value }; }
    };

    const context = vm.createContext({
        console,
        document,
        window: { location: { href: '' } },
        navigator: { userAgent: 'Android' },
        URLSearchParams,
        TextEncoder,
        CompressionStream: undefined,
        btoa(value) {
            return Buffer.from(value, 'binary').toString('base64');
        },
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout
    });

    vm.runInContext(scriptSource, context, { filename: 'script.js' });
    return context;
}


test('shared city configuration supplies frontend metadata and route settings', () => {
    const context = makeContext();
    context.configureCities(cityConfigData);

    const nyc = context.getCityConfig('nyc');
    assert.equal(nyc.name, 'New York');
    assert.equal(nyc.url, 'https://nycpokemap.com');
    assert.equal(nyc.tz, 'America/New_York');
    assert.equal(nyc.route.hexSizeMeters, 700);
    assert.ok(Number.isFinite(nyc.route.bounds.minLat));
});

test('city availability distinguishes empty data from scraper failures and supports legacy booleans', () => {
    const context = makeContext();

    assert.equal(context.normalizeCityStatus(true), 'available');
    assert.equal(context.normalizeCityStatus(false), 'empty');
    assert.equal(context.normalizeCityStatus({ state: 'available' }), 'available');
    assert.equal(context.normalizeCityStatus({ state: 'empty' }), 'empty');
    assert.equal(context.normalizeCityStatus({ state: 'error' }), 'error');
    assert.equal(context.normalizeCityStatus({ state: 'unexpected' }), 'available');
});

test('GPX builder emits well-formed XML and escapes route names', () => {
    const context = makeContext();
    const route = [
        { lat: 40.1, lng: -73.9, name: 'A & B <Stop>' },
        { lat: 40.2, lng: -73.8, name: 'Quote " Stop' }
    ];
    const city = { name: 'New & York', cityKey: 'nyc' };
    const built = context.buildGpxRoute(route, city, '2026-10-03');

    assert.equal(built.filename, '2026-10-03-nyc.gpx');
    assert.match(built.gpx, /<name>2026-10-03-nyc<\/name>/);
    assert.match(built.gpx, /<name>A &amp; B &lt;Stop&gt;<\/name>/);
    assert.match(built.gpx, /<name>Quote &quot; Stop<\/name>/);
    assert.doesNotMatch(built.gpx, /<name>1\. /);
    assert.doesNotMatch(built.gpx, /<name>2\. /);
    assert.equal((built.gpx.match(/<rtept\b/g) || []).length, 2);
    assert.match(built.gpx, /xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);

    const parsed = spawnSync(
        'python3',
        [
            '-c',
            [
                'import sys, xml.etree.ElementTree as ET',
                'root = ET.fromstring(sys.stdin.read())',
                "ns = '{http://www.topografix.com/GPX/1/1}'",
                "assert root.tag == ns + 'gpx'",
                "assert len(root.findall('.//' + ns + 'rtept')) == 2"
            ].join('; ')
        ],
        { input: built.gpx, encoding: 'utf8' }
    );
    assert.equal(
        parsed.status,
        0,
        parsed.stderr || 'generated GPX should parse with the GPX 1.1 namespace'
    );
});

test('city-local route date follows the selected city timezone instead of UTC', () => {
    const context = makeContext();

    // Just after midnight UTC, New York is still on the previous calendar day.
    const afterUtcMidnight = new Date('2026-10-03T00:30:00Z');
    assert.equal(
        context.getDateStringInTimeZone('America/New_York', afterUtcMidnight),
        '2026-10-02'
    );
    assert.equal(
        context.getDateStringInTimeZone('Asia/Singapore', afterUtcMidnight),
        '2026-10-03'
    );

    // Later the same UTC day, Sydney has already advanced to the next day.
    const beforeUtcMidnight = new Date('2026-10-03T15:30:00Z');
    assert.equal(
        context.getDateStringInTimeZone('Australia/Sydney', beforeUtcMidnight),
        '2026-10-04'
    );
    assert.equal(
        context.getDateStringInTimeZone('America/Vancouver', beforeUtcMidnight),
        '2026-10-03'
    );
});

test('route generation loads worker from a stable cacheable URL', async () => {
    const context = makeContext();
    let workerUrl = null;
    let workerPayload = null;

    context.document.querySelectorAll = () => [{ checked: true }];
    context.getCustomStartLocation = () => null;
    context.getCheckedFilterKeys = () => ['2,1,1,Some task'];
    context.getSelectedCityConfig = () => cityConfigs.nyc;
    context.setStatus = () => {};
    context.fetch = async () => ({
        ok: true,
        json: async () => ({
            quests: [{
                rewards_types: '2',
                rewards_ids: '1',
                rewards_amounts: '1',
                conditions_string: 'Some task',
                lat: 40.75,
                lng: -73.99,
                name: 'Test Stop'
            }]
        })
    });
    context.openRouteInGpsJoystick = async () => {};

    context.Worker = function Worker(url) {
        workerUrl = url;
        this.postMessage = payload => {
            workerPayload = payload;
            Promise.resolve().then(() => this.onmessage({ data: payload.points }));
        };
        this.terminate = () => {};
    };

    await context.handleRouteGeneration('import');

    assert.equal(workerUrl, './worker.js');
    assert.deepEqual(workerPayload.cityConfig, cityConfigs.nyc.route);
});

test('custom start with zero matching quests exits before creating a worker', async () => {
    const context = makeContext();
    const statuses = [];
    let workerCreated = false;

    context.document.querySelectorAll = () => [{ checked: true }];
    context.getCustomStartLocation = () => ({ lat: 40.75, lng: -73.99 });
    context.getCheckedFilterKeys = () => ['2,1,1,Some task'];
    context.getSelectedCityConfig = () => cityConfigs.nyc;
    context.setStatus = (message, type) => statuses.push({ message, type });
    context.fetch = async () => ({ ok: true, json: async () => ({ quests: [] }) });
    context.Worker = function Worker() {
        workerCreated = true;
        throw new Error('worker must not be created for zero quest matches');
    };

    await context.handleRouteGeneration('download');

    assert.equal(workerCreated, false);
    assert.ok(statuses.some(entry =>
        entry.type === 'error' && entry.message.includes('No matching Pokéstops')
    ));
});

test('GPS Joystick direct-import fallback preserves GPX payload', async () => {
    const context = makeContext();
    const gpx = '<?xml version="1.0"?><gpx><rte><name>Test</name></rte></gpx>';

    await context.openRouteInGpsJoystick(gpx, 'test_route.gpx');

    const href = context.window.location.href;
    assert.ok(href.startsWith('intent://import-route?'));
    assert.ok(href.endsWith('#Intent;scheme=gpsjoystick;package=com.priyank.gpsjoystick;end'));

    const query = href.slice('intent://import-route?'.length, href.indexOf('#Intent;'));
    const params = new URLSearchParams(query);
    assert.equal(params.get('v'), '1');
    assert.equal(params.get('encoding'), 'base64url');
    assert.equal(params.get('filename'), 'test_route.gpx');
    assert.equal(params.get('group'), 'Daily Quests');

    const encoded = params.get('data');
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
    assert.equal(Buffer.from(padded, 'base64').toString('utf8'), gpx);
});

test('GPS Joystick gzip payload round-trips to the original GPX', async () => {
    const context = makeContext();
    context.CompressionStream = CompressionStream;
    context.Blob = Blob;
    context.Response = Response;

    const gpx = '<?xml version="1.0"?><gpx><rte><name>2026-10-03-nyc</name></rte></gpx>';
    const payload = await context.encodeGpsJoystickPayload(gpx);

    assert.equal(payload.encoding, 'gzip-base64url');
    const encoded = payload.data;
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
    const compressed = Buffer.from(padded, 'base64');
    assert.equal(zlib.gunzipSync(compressed).toString('utf8'), gpx);
});
