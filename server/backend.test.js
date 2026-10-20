import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyFoodMemory, createApp, parseNutritionResponse, readConfiguration, readTrafficConfiguration } from './index.js';

const configuration = { apiKey: '', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' };
const milk = {
  name: '我的牛奶', productId: 'milk-1', quantity: 150, unit: 'ml', baseQuantity: 240,
  baseUnit: 'ml', kcal: 160, protein: 8, carbs: 11, fat: 9, source: 'memory', confidence: 'high',
};

async function serve(t, client, options = {}) {
  const server = createApp({ configuration, client, ...options }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('configuration uses ordinary environment variable names and safe defaults', () => {
  const actual = readConfiguration({ DEEPSEEK_API_KEY: ' test-key ', DEEPSEEK_MODEL: ' custom-model ' });
  assert.equal(actual.apiKey, 'test-key');
  assert.equal(actual.model, 'custom-model');
  assert.equal(actual.baseURL, 'https://api.deepseek.com');
});

test('nutrition parser preserves reference-unit nutrition without counting it as consumed nutrition', () => {
  const output = parseNutritionResponse(`\`\`\`json\n${JSON.stringify({ items: [milk], note: '来自个人食品' })}\n\`\`\``);
  assert.equal(output.items[0].kcal, 160);
  assert.equal(output.items[0].quantity / output.items[0].baseQuantity * output.items[0].kcal, 100);
  assert.equal(output.items[0].productId, 'milk-1');
  assert.equal(output.provider, 'deepseek');
  assert.ok(output.items[0].id);
});

test('nutrition parser rejects incomplete nutrition and incompatible units', () => {
  assert.throws(() => parseNutritionResponse(JSON.stringify({ items: [{ ...milk, protein: null }] })), /完整/);
  assert.throws(() => parseNutritionResponse(JSON.stringify({ items: [{ ...milk, baseUnit: 'g' }] })), /单位/);
  assert.throws(() => parseNutritionResponse(JSON.stringify({ items: [{ ...milk, quantity: 0 }] })), /数值/);
  assert.throws(() => parseNutritionResponse(JSON.stringify({ items: [{ ...milk, kcal: -1 }] })), /数值/);
  assert.throws(() => parseNutritionResponse(JSON.stringify({ items: [] })), /明细/);
});

test('confirmed personal nutrition overrides memory tampering but leaves current label data intact', () => {
  const output = parseNutritionResponse(JSON.stringify({ items: [{ ...milk, kcal: 99 }], note: '草稿' }));
  const corrected = applyFoodMemory(output, { products: [{ ...milk, id: 'milk-1', name: '已确认的牛奶', baseQuantity: 240 }] });
  assert.equal(corrected.items[0].kcal, 160);
  assert.equal(corrected.items[0].name, '已确认的牛奶');
  assert.equal(corrected.items[0].quantity, 150);
  assert.throws(() => applyFoodMemory(output, { products: [{ ...milk, id: 'milk-1', unit: 'g' }] }), /单位/);
  assert.throws(() => applyFoodMemory(output, { products: [] }), /食品库/);
  const label = parseNutritionResponse(JSON.stringify({ items: [{ ...milk, name: '另一款牛奶', source: 'label', kcal: 120 }], note: '标签' }));
  const kept = applyFoodMemory(label, { products: [{ ...milk, id: 'milk-1' }] });
  assert.equal(kept.items[0].kcal, 120);
  assert.equal(kept.items[0].name, '另一款牛奶');
  assert.equal(kept.items[0].productId, null);
});

test('status does not leak key, and missing key errors truthfully', async (t) => {
  const url = await serve(t);
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.configured, false);
  assert.equal(status.imageSupport, 'unverified');
  assert.equal('apiKey' in status, false);
  const response = await fetch(`${url}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '牛奶 150ml' }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'API_NOT_CONFIGURED');
});

test('analyze uses configured model, thinking parameters, separated memory and image', async (t) => {
  let captured;
  const client = { chat: { completions: { create: async (payload, options) => {
    captured = { payload, options };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [milk], note: '按标签' }) } }] };
  } } } };
  const url = await serve(t, client);
  const response = await fetch(`${url}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '我的牛奶150ml', image: 'data:image/png;base64,aGVsbG8=', memory: { products: [{ ...milk, id: 'milk-1' }], recipes: [] } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].kcal, 160);
  assert.equal(captured.payload.model, 'deepseek-flash');
  assert.equal(captured.payload.reasoning_effort, 'high');
  assert.deepEqual(captured.payload.thinking, { type: 'enabled' });
  assert.equal(captured.payload.stream, false);
  assert.equal(captured.options.maxRetries, 0);
  assert.equal(captured.payload.messages[1].content[1].type, 'image_url');
  assert.match(captured.payload.messages[1].content[0].text, /milk-1/);
});

test('provider image errors are explicit and sanitized with no fake fallback', async (t) => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    throw Object.assign(new Error('Unsupported image_url; secret should never show'), { status: 400 });
  } } } };
  const url = await serve(t, client);
  const response = await fetch(`${url}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'data:image/png;base64,aGVsbG8=' }) });
  assert.equal(response.status, 422);
  const error = await response.json();
  assert.equal(error.code, 'IMAGE_NOT_SUPPORTED');
  assert.doesNotMatch(error.error, /secret/);
  assert.equal(calls, 1);
});

test('advice passes actual context and returns answer only, never chain-of-thought', async (t) => {
  let messages;
  const client = { chat: { completions: { create: async (payload) => {
    messages = payload.messages;
    return { choices: [{ message: { content: '截至目前已记录 626 kcal，晚餐尚未记录，不能判断全天不足。', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }] };
  } } } };
  const url = await serve(t, client);
  const response = await fetch(`${url}/api/advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '今天吃够了吗', context: { intake: 626, dayComplete: false, currentTime: '2026-10-16T14:30:00+08:00' } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'deepseek');
  assert.match(body.answer, /626/);
  assert.equal('reasoning_content' in body, false);
  assert.match(messages[1].content, /"dayComplete":false/);
  assert.match(messages[0].content, /截至目前已记录/);
});

test('demo health data always declares simulation and cannot claim connected', async (t) => {
  const url = await serve(t);
  for (const source of ['xiaomi', 'huawei']) {
    const response = await fetch(`${url}/api/health/demo-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.demo, true);
    assert.equal(data.connected, false);
    assert.ok(data.activeCalories > 0);
    assert.match(data.note, /模拟/);
    assert.equal(data.timezone, 'Asia/Shanghai');
  }
  const response = await fetch(`${url}/api/health/demo-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'apple' }) });
  assert.equal(response.status, 400);
});

test('malformed requests get friendly JSON errors', async (t) => {
  const url = await serve(t);
  const response = await fetch(`${url}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_JSON');
});

function mockClient(create) {
  return { chat: { completions: { create } } };
}

function modelResult(payload) {
  const isFood = payload.messages[0].content.includes('食物记录助手');
  return { choices: [{ finish_reason: 'stop', message: {
    content: isFood ? JSON.stringify({ items: [{ ...milk, source: 'estimate' }], note: '估算' }) : '截至目前已记录的数据可作为参考。',
  } }] };
}

function post(url, path, body, headers = {}) {
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('traffic configuration enables only the explicitly supported loopback proxy and safe positive limits', () => {
  assert.deepEqual(readTrafficConfiguration({}), { trustProxy: false, windowMs: 60_000, maxRequests: 10, maxConcurrent: 3 });
  assert.equal(readTrafficConfiguration({ LEANWISE_TRUST_PROXY: 'loopback' }).trustProxy, true);
  for (const value of ['true', '*', '1', '127.0.0.1,0.0.0.0/0']) {
    assert.equal(readTrafficConfiguration({ LEANWISE_TRUST_PROXY: value }).trustProxy, false);
  }
  const invalid = readTrafficConfiguration({ API_RATE_LIMIT_WINDOW_MS: '-1', API_RATE_LIMIT_MAX: '0', API_MAX_CONCURRENT: 'NaN' });
  assert.equal(invalid.windowMs, 60_000);
  assert.equal(invalid.maxRequests, 10);
  assert.equal(invalid.maxConcurrent, 3);
  assert.deepEqual(readTrafficConfiguration({ API_RATE_LIMIT_WINDOW_MS: '2000', API_RATE_LIMIT_MAX: '4', API_MAX_CONCURRENT: '2' }), {
    trustProxy: false, windowMs: 2000, maxRequests: 4, maxConcurrent: 2,
  });
});

test('AI limit is shared between analyze and advice, resets, and ignores unrelated or invalid requests', async (t) => {
  let calls = 0;
  let time = 100_000;
  const url = await serve(t, mockClient(async (payload) => { calls += 1; return modelResult(payload); }), {
    trafficConfiguration: { trustProxy: false, windowMs: 60_000, maxRequests: 2, maxConcurrent: 3 }, now: () => time,
  });
  assert.equal((await post(url, '/api/analyze', {})).status, 400);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await fetch(`${url}/api/status`)).status, 200);
    assert.equal((await post(url, '/api/health/demo-sync', { source: 'xiaomi' })).status, 200);
  }
  assert.equal((await post(url, '/api/analyze', { text: '牛奶 150ml' })).status, 200);
  assert.equal((await post(url, '/api/advice', { question: '下一餐如何安排？' })).status, 200);
  const limited = await post(url, '/api/advice', { question: '下一餐如何安排？' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.equal(limited.headers.get('Cache-Control'), 'no-store');
  assert.equal((await limited.json()).code, 'API_RATE_LIMIT');
  assert.equal(calls, 2);
  assert.equal((await post(url, '/api/health/demo-sync', { source: 'huawei' })).status, 200);
  time += 60_000;
  assert.equal((await post(url, '/api/advice', { question: '下一餐如何安排？' })).status, 200);
  assert.equal(calls, 3);
});

test('unconfigured API requests never consume AI allowance', async (t) => {
  const url = await serve(t, undefined, { trafficConfiguration: { maxRequests: 1, maxConcurrent: 1 } });
  for (let i = 0; i < 3; i += 1) {
    const response = await post(url, '/api/advice', { question: '下一餐如何安排？' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'API_NOT_CONFIGURED');
  }
});

test('global concurrency spans different proxy clients, and busy requests do not consume their allowance', async (t) => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  let calls = 0;
  const url = await serve(t, mockClient(async (payload) => {
    calls += 1;
    if (calls === 1) {
      firstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return modelResult(payload);
  }), { trafficConfiguration: { trustProxy: true, maxConcurrent: 1, maxRequests: 1 } });
  const first = post(url, '/api/advice', { question: '吃什么？' }, { 'X-Forwarded-For': '203.0.113.1' });
  await started;
  const busy = await post(url, '/api/analyze', { text: '牛奶' }, { 'X-Forwarded-For': '203.0.113.2' });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('Retry-After'), '2');
  assert.equal((await busy.json()).code, 'API_BUSY');
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await post(url, '/api/analyze', { text: '牛奶' }, { 'X-Forwarded-For': '203.0.113.2' })).status, 200);
  assert.equal(calls, 2);
});

test('SDK failures release concurrency while still counting the attempted provider request', async (t) => {
  let calls = 0;
  const url = await serve(t, mockClient(async (payload) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('provider unavailable'), { status: 500 });
    return modelResult(payload);
  }), { trafficConfiguration: { trustProxy: false, maxConcurrent: 1, maxRequests: 2 } });
  const failed = await post(url, '/api/advice', { question: '下一餐如何安排？' });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await post(url, '/api/advice', { question: '下一餐如何安排？' })).status, 200);
  assert.equal((await post(url, '/api/advice', { question: '下一餐如何安排？' })).status, 429);
  assert.equal(calls, 2);
});

test('direct clients cannot evade limits with X-Forwarded-For when proxy trust is disabled', async (t) => {
  const url = await serve(t, mockClient(async (payload) => modelResult(payload)), {
    trafficConfiguration: { trustProxy: false, maxRequests: 1 },
  });
  assert.equal((await post(url, '/api/advice', { question: '吃什么？' }, { 'X-Forwarded-For': '203.0.113.10' })).status, 200);
  assert.equal((await post(url, '/api/advice', { question: '吃什么？' }, { 'X-Forwarded-For': '203.0.113.11' })).status, 429);
});

test('loopback proxy mode trusts only the nearest untrusted IP, not an arbitrary forwarded chain', async (t) => {
  const url = await serve(t, mockClient(async (payload) => modelResult(payload)), {
    trafficConfiguration: { trustProxy: true, maxRequests: 1 },
  });
  assert.equal((await post(url, '/api/advice', { question: '吃什么？' }, { 'X-Forwarded-For': '198.51.100.10, 203.0.113.50' })).status, 200);
  assert.equal((await post(url, '/api/advice', { question: '吃什么？' }, { 'X-Forwarded-For': '198.51.100.11, 203.0.113.50' })).status, 429);
  assert.equal((await post(url, '/api/advice', { question: '吃什么？' }, { 'X-Forwarded-For': '203.0.113.51' })).status, 200);
});

test('production static files and SPA routes are served without converting unknown API routes to HTML', async (t) => {
  const distDirectory = await mkdtemp(join(tmpdir(), 'leanwise-static-'));
  t.after(async () => {
    await rm(join(distDirectory, 'assets', 'app.js'), { force: true });
    await rm(join(distDirectory, 'index.html'), { force: true });
    await rmdir(join(distDirectory, 'assets'));
    await rmdir(distDirectory);
  });
  await mkdir(join(distDirectory, 'assets'));
  await writeFile(join(distDirectory, 'index.html'), '<!doctype html><title>Leanwise production</title>');
  await writeFile(join(distDirectory, 'assets', 'app.js'), 'window.leanwise = true;');
  const url = await serve(t, undefined, { distDirectory });
  for (const route of ['/', '/today']) {
    const response = await fetch(`${url}${route}`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /text\/html/);
    assert.match(await response.text(), /Leanwise production/);
  }
  const asset = await fetch(`${url}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('Content-Type'), /javascript/);
  assert.match(await asset.text(), /window\.leanwise/);
  const unknown = await fetch(`${url}/api/unknown`, { headers: { Accept: 'text/html' } });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'API_NOT_FOUND');
});
