const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

function runtime() {
  const values = new Map();
  const requests = [];
  const cache = new Map();
  const wx = {
    getStorageSync: key => structuredClone(values.get(key)),
    setStorageSync: (key, value) => values.set(key, structuredClone(value)),
    removeStorageSync: key => values.delete(key),
    showModal: options => options.success({ confirm: true }),
    showToast() {}, navigateBack() {},
    request(options) { requests.push(options); options.success({ statusCode: 200, data: { items: [], answer: 'test' } }); },
    getFileSystemManager() { return { saveFile(options) { options.success({ savedFilePath: 'local/saved.jpg' }); }, removeSavedFile() {} }; }
  };
  function load(relative) {
    const full = path.resolve(root, relative.endsWith('.js') ? relative : relative + '.js');
    if (cache.has(full)) return cache.get(full);
    const module = { exports: {} };
    const context = { module, exports: module.exports, wx, console, setTimeout: callback => callback(),
      require: name => load(path.relative(root, path.resolve(path.dirname(full), name))),
      Page: value => { module.exports = value; }, App() {} };
    vm.runInNewContext(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''), context, { filename: full });
    cache.set(full, module.exports);
    return module.exports;
  }
  function page(relative) {
    const definition = load(relative);
    const instance = { ...definition, data: structuredClone(definition.data) };
    instance.setData = changes => {
      Object.entries(changes).forEach(([key, value]) => {
        if (key.includes('.')) { const [parent, child] = key.split('.'); instance.data[parent][child] = value; }
        else instance.data[key] = value;
      });
    };
    return instance;
  }
  return { values, requests, wx, load, page, store: load('utils/storage') };
}
function item(overrides = {}) {
  return { id: 'food-item', productId: null, name: '我的牛奶', quantity: 150, unit: 'ml', baseQuantity: 240, baseUnit: 'ml',
    kcal: 160, protein: 8, carbs: 11, fat: 9, source: 'label', confidence: 'high', ...overrides };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('all mini program JS and JSON parse; pages and WXML event handlers exist', () => {
  const rt = runtime();
  let jsCount = 0;
  let jsonCount = 0;
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'tests') inspect(full); continue; }
      const source = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
      if (entry.name.endsWith('.js')) { new vm.Script(source, { filename: full }); jsCount++; }
      if (entry.name.endsWith('.json')) { JSON.parse(source); jsonCount++; }
      if (entry.name.endsWith('.wxml')) {
        const definition = full === path.join(root, 'privacy.wxml') ? rt.load('utils/privacy') : rt.load(path.relative(root, full.replace(/\.wxml$/, '.js')));
        for (const match of source.matchAll(/(?:bind|catch)(?:tap|input|change|agreeprivacyauthorization)="([^"]+)"/g)) {
          assert.equal(typeof definition[match[1]], 'function', full + ': ' + match[1]);
        }
      }
    }
  }
  inspect(root);
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(project.appid, 'wx5971d92eb86b0234');
  assert.equal(rt.load('config').apiBaseUrl, 'https://www.leanwise.lydiaowo.com');
  app.pages.forEach(page => ['.js', '.wxml', '.wxss', '.json'].forEach(extension => assert.ok(fs.existsSync(path.join(root, page + extension)))));
  assert.ok(jsCount >= 9 && jsonCount >= 8);
});

test('WeChat privacy waits for explicit agree button and can be declined', () => {
  const rt = runtime();
  rt.wx.getPrivacySetting = options => options.success({ privacyContractName: '隐私指引' });
  const page = rt.page('pages/record/record');
  const replies = [];
  page.showPrivacyPrompt(result => replies.push(result));
  assert.equal(page.data.showPrivacy, true);
  assert.equal(replies.length, 0);
  page.agreePrivacy();
  assert.deepEqual(plain(replies[0]), { buttonId: 'leanwise-privacy-agree', event: 'agree' });
  page.showPrivacyPrompt(result => replies.push(result));
  page.disagreePrivacy();
  assert.deepEqual(plain(replies[1]), { event: 'disagree' });
});

test('nutrition is a serving ratio and missing/invalid fields cannot be saved', () => {
  const { store } = runtime();
  assert.deepEqual(plain(store.itemTotals(item())), { kcal: 100, protein: 5, carbs: 6.9, fat: 5.6 });
  assert.equal(Boolean(store.validItem(item({ kcal: '' }))), false);
  assert.equal(Boolean(store.validItem(item({ quantity: 0 }))), false);
  assert.equal(Boolean(store.validItem(item({ baseUnit: 'g' }))), false);
});

test('brand replacement preserves old product and old historical nutrition', () => {
  const { store } = runtime();
  const first = store.rememberItems([store.snapshotItem(item())], []);
  const history = structuredClone(first.items);
  const changedBrand = store.rememberItems([store.snapshotItem(item({ productId: first.products[0].id, name: '另一个品牌牛奶', kcal: 120 }))], first.products);
  assert.equal(changedBrand.products.length, 2);
  assert.equal(changedBrand.products[0].kcal, 160);
  const corrected = store.rememberItems([store.snapshotItem(item({ productId: first.products[0].id, kcal: 200 }))], changedBrand.products);
  assert.equal(corrected.products.length, 2);
  assert.equal(corrected.products[0].kcal, 200);
  assert.equal(history[0].kcalTotal, 100);
});

test('recipe uses current personal nutrition and keeps its usual serving', () => {
  const { store } = runtime();
  const first = store.rememberItems([store.snapshotItem(item())], []);
  const recipe = { id: 'recipe', name: '咖啡牛奶', aliases: ['咖啡牛奶'], items: first.items };
  const products = store.rememberItems([store.snapshotItem(item({ productId: first.products[0].id, quantity: 200, kcal: 192 }))], first.products).products;
  const result = store.expandRecipe(recipe, products);
  assert.equal(result[0].quantity, 150);
  assert.equal(result[0].kcal, 192);
  assert.equal(store.itemTotals(result[0]).kcal, 120);
  assert.equal(recipe.items[0].kcal, 160);
});

test('saved data remains available after loading a new page and target is not hardcoded', async () => {
  const rt = runtime();
  rt.values.set(rt.store.storageKeys.profile, { ...plain(rt.store.defaultProfile), dailyTarget: 2100, targetWeight: 58 });
  const record = rt.page('pages/record/record');
  record.setDraft([item()]);
  record.data.text = '牛奶 150ml';
  await record.save();
  const home = rt.page('pages/index/index');
  home.refresh();
  assert.equal(home.data.todayRecords.length, 1);
  assert.equal(home.data.summary.kcal, 100);
  assert.equal(home.data.target, 2100);
  assert.equal(home.data.remaining, 2000);
});

test('photo-only stays a manual draft and text analysis never sends an image', async () => {
  const rt = runtime();
  const page = rt.page('pages/record/record');
  page.data.imagePath = 'local/photo.jpg';
  await page.analyze();
  assert.equal(rt.requests.length, 0);
  assert.match(page.data.error, /不支持图片/);
  page.data.text = '牛奶 150ml';
  await page.analyze();
  assert.equal(rt.requests.length, 1);
  assert.equal(rt.requests[0].data.image, undefined);
  assert.equal(rt.requests[0].data.text, '牛奶 150ml');
  assert.ok(Array.isArray(rt.requests[0].data.memory.products));
});

test('exact recipe text reuses local confirmed data without an API request', async () => {
  const rt = runtime();
  const first = rt.store.rememberItems([rt.store.snapshotItem(item())], []);
  rt.store.commit({ products: first.products, recipes: [{ id: 'recipe', name: '咖啡牛奶', aliases: ['咖啡牛奶'], items: first.items }] });
  const page = rt.page('pages/record/record');
  page.data.text = '咖啡牛奶';
  await page.analyze();
  assert.equal(rt.requests.length, 0);
  assert.equal(page.data.draft[0].kcal, 160);
  assert.equal(page.data.draft[0].quantity, 150);
});

test('advisor context includes actual target, weights, partial day and labeled demo; excludes photos', () => {
  const { store } = runtime();
  store.commit({ records: [{ id: 'meal', date: store.today(), time: '10:00', photo: 'local/private.jpg', items: [store.snapshotItem(item())] }],
    profile: { ...store.defaultProfile, dailyTarget: 2100, targetWeight: 58 }, weights: [{ id: 'weight', date: store.today(), value: 62.1 }],
    health: [{ source: 'xiaomi', date: store.today(), demo: true, connected: false, activeCalories: 386 }],
    preferences: { energyMode: 'device', healthSource: 'xiaomi' } });
  const context = store.advisorContext();
  assert.equal(context.target.dailyKcal, 2100);
  assert.equal(context.today.totals.kcal, 100);
  assert.equal(context.today.complete, false);
  assert.equal(context.weights[0].value, 62.1);
  assert.equal(context.energy.selectedHealth.demo, true);
  assert.equal(JSON.stringify(context).includes('private.jpg'), false);
  assert.equal(context.energy.estimate, null);
});

test('backup restores validated data, rejects real health samples and ignores photo references', () => {
  const { store } = runtime();
  const backup = { format: 'leanwise-miniprogram', version: 1, data: {
    records: [{ id: 'meal', date: store.today(), time: '10:00', photo: 'unsafe/path', items: [item()] }], products: [], recipes: [],
    weights: [], health: [], completedDates: [], profile: store.defaultProfile, preferences: { energyMode: 'estimate', healthSource: 'xiaomi' } } };
  const restored = store.validateBackup(backup);
  assert.equal(restored.records[0].photo, undefined);
  assert.equal(restored.records[0].items[0].kcalTotal, 100);
  assert.throws(() => store.validateBackup({ ...backup, data: { ...backup.data, records: [{ ...backup.data.records[0], items: [item({ baseQuantity: 0 })] }] } }));
  assert.throws(() => store.validateBackup({ ...backup, data: { ...backup.data, health: [{ source: 'xiaomi', demo: false, date: store.today(), activeCalories: 386 }] } }));
});

test('shared Web API routes and remembered food validation work with mini program data', async () => {
  const { store } = runtime();
  const first = store.rememberItems([store.snapshotItem(item())], []);
  const server = await import('../../server/index.js');
  const response = server.applyFoodMemory(server.parseNutritionResponse(JSON.stringify({ items: [item({
    productId: first.products[0].id, source: 'memory', kcal: 999
  })] })), { products: first.products });
  assert.equal(response.items[0].kcal, 160);
  assert.equal(response.items[0].baseQuantity, 240);
  assert.equal(response.items[0].quantity, 150);
});
