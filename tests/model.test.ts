import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advisorContext, applyConfirmedMemory, dayTotals, initialData, itemTotals,
  loadData, mealTotals, resolveLocalMeal, saveData, STORAGE_KEY, today,
  type Meal, type MealItem,
} from '../src/model.ts';
import { sampleData } from './fixtures.ts';

test('a new user starts with no sample meals, foods, recipes, weights or profile', () => {
  const data = initialData();
  assert.deepEqual([data.meals, data.products, data.recipes, data.weights, data.completedDates], [[], [], [], [], []]);
  assert.equal(data.profile.name, '');
  assert.equal(data.profile.dailyTarget, 0);
  assert.equal(resolveLocalMeal('一个鸡蛋', data), null);
  const context = advisorContext(data, today());
  assert.equal(context.profileSet, false);
  assert.equal(context.remainingBudget, null);
  assert.equal(context.energy, null);
  assert.equal(context.meals.length, 0);
});

test('own label is proportional: 150 ml of 160 kcal / 240 ml milk is 100 kcal', () => {
  const data = sampleData();
  const result = resolveLocalMeal('150ml牛奶', data)!;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].baseQuantity, 240);
  assert.equal(result.items[0].kcal, 160);
  assert.equal(itemTotals(result.items[0]).kcal, 100);
  assert.equal(itemTotals(result.items[0]).protein, 5.625);
});

test('current milk quantity overrides memory without changing the saved recipe', () => {
  const data = sampleData();
  const result = resolveLocalMeal('咖啡牛奶，牛奶200ml', data)!;
  assert.equal(result.items.find(item => item.productId === 'milk-own')?.quantity, 200);
  assert.equal(result.items.find(item => item.productId === 'coffee')?.quantity, 150);
  assert.equal(data.recipes[0].items.find(item => item.productId === 'milk-own')?.quantity, 150);
  const next = resolveLocalMeal('咖啡牛奶', data)!;
  assert.equal(next.items.find(item => item.productId === 'milk-own')?.quantity, 150);
});

test('confirmed product change affects new drafts and leaves recorded meal snapshots intact', () => {
  const data = sampleData();
  const pastMilk = data.meals[0].items.find(item => item.productId === 'milk-own')!;
  assert.equal(itemTotals(pastMilk).kcal, 100);
  data.products = data.products.map(product => product.id === 'milk-own'
    ? { ...product, kcal: 120, version: 2, source: '用户纠正营养标签' }
    : product);
  const next = resolveLocalMeal('咖啡牛奶', data)!;
  assert.equal(itemTotals(next.items.find(item => item.productId === 'milk-own')!).kcal, 75);
  assert.equal(pastMilk.kcal, 160);
  assert.equal(itemTotals(pastMilk).kcal, 100);
  assert.equal(data.recipes[0].items.find(item => item.productId === 'milk-own')?.kcal, 160);
});

test('personal recipe and egg remain separate editable ingredients', () => {
  const data = sampleData();
  const result = resolveLocalMeal('喝了300ml咖啡牛奶（牛奶大约150ml），吃了一个煮鸡蛋', data)!;
  assert.deepEqual(result.items.map(item => item.productId), ['milk-own', 'coffee', 'egg']);
  assert.deepEqual(result.items.map(item => item.unit), ['ml', 'ml', '个']);
  assert.equal(result.items[2].quantity, 1);
  assert.match(result.note, /本地规则解析/);
});

test('explicit Chinese food portions and cooking oil are parsed independently', () => {
  const data = sampleData();
  const result = resolveLocalMeal('半碗米饭，150g鸡胸肉，100g生菜，5g油，两个鸡蛋', data)!;
  assert.equal(result.items.find(item => item.productId === 'rice')?.quantity, 75);
  assert.equal(result.items.find(item => item.productId === 'chicken')?.quantity, 150);
  assert.equal(result.items.find(item => item.productId === 'oil')?.quantity, 5);
  assert.equal(result.items.find(item => item.productId === 'egg')?.quantity, 2);
});

test('zero ingredient is explicit: a one-off zero milk does not replace it with default milk', () => {
  const data = sampleData();
  const result = resolveLocalMeal('咖啡牛奶，牛奶0ml', data)!;
  assert.equal(result.items.find(item => item.productId === 'milk-own')?.quantity, 0);
  assert.equal(data.recipes[0].items.find(item => item.productId === 'milk-own')?.quantity, 150);
});

test('confirmed memory uses product id, retains quantity, and does not infer brands', () => {
  const data = sampleData();
  const saved = data.recipes[0].items[0];
  const amended = { ...saved, kcal: 999 };
  const applied = applyConfirmedMemory([amended], data, '牛奶200ml');
  assert.equal(applied[0].kcal, 160);
  assert.equal(applied[0].quantity, 200);
  assert.equal(amended.kcal, 999);
  assert.equal(saved.quantity, 150);
  const unknown: MealItem = { ...saved, productId: undefined, name: 'B品牌牛奶', kcal: 90 };
  assert.equal(applyConfirmedMemory([unknown], data, 'B品牌牛奶200ml')[0].kcal, 90);
  const currentLabel: MealItem = { ...saved, source: 'label', kcal: 90 };
  assert.equal(applyConfirmedMemory([currentLabel], data)[0].kcal, 90);
});

test('local parser refuses an unknown explicit brand rather than guessing personal milk', () => {
  const data = sampleData();
  assert.equal(resolveLocalMeal('B品牌牛奶200ml', data), null);
  assert.equal(resolveLocalMeal('蒙牛牛奶200ml', data), null);
  const known = { ...data.products[0], id: 'milk-b', name: 'B品牌牛奶', brand: 'B品牌', aliases: ['B品牌牛奶'], kcal: 120 };
  data.products = [...data.products, known];
  const result = resolveLocalMeal('B品牌牛奶200ml', data)!;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].productId, 'milk-b');
  assert.equal(result.items[0].kcal, 120);
  assert.equal(resolveLocalMeal('咖啡牛奶，换成B品牌牛奶200ml', data), null);
});

test('day totals keep precision until final aggregate and match the saved items', () => {
  const data = sampleData();
  const item: MealItem = {
    id: 'tiny', name: '测试小份量', quantity: 1, unit: 'g', baseQuantity: 3,
    baseUnit: 'g', kcal: 1, protein: 1, carbs: 1, fat: 1, source: '测试',
  };
  const meal: Meal = { id: 'm1', date: today(), time: '12:00', type: '午餐', items: [item, { ...item, id: 'tiny2' }, { ...item, id: 'tiny3' }] };
  data.meals = [meal];
  assert.equal(itemTotals(item).kcal, 1 / 3);
  assert.equal(mealTotals(meal).kcal, 1);
  assert.equal(dayTotals(data, today()).kcal, 1);
  data.meals = meal.items.map((entry, index) => ({ ...meal, id: `split-${index}`, items: [entry] }));
  assert.equal(dayTotals(data, today()).kcal, 1);
});

test('advisor sees today as incomplete and uses only the user profile and records', () => {
  const data = sampleData();
  const context = advisorContext(data, today());
  assert.equal(context.isComplete, false);
  assert.equal(context.recentDays[0].complete, false);
  assert.ok(context.completeDayCount > 0);
  assert.equal(context.profileSet, true);
  assert.equal(context.energy?.fullDayBudget, 1750);
  assert.equal(context.remainingBudget, 1750 - dayTotals(data, today()).kcal);
  assert.ok(!JSON.stringify(context).includes('模拟'));
  assert.ok(context.adviceRules.some(rule => rule.includes('缺失记录不是零摄入')));
  data.completedDates = [...data.completedDates, today()];
  assert.equal(advisorContext(data, today()).isComplete, true);
});

test('localStorage keeps edited snapshots and malformed JSON safely falls back', () => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  });
  try {
    const data = sampleData();
    data.meals[0].items[0].quantity = 211;
    saveData(data);
    assert.equal(loadData().meals[0].items[0].quantity, 211);
    storage.set(STORAGE_KEY, '{broken');
    assert.equal(loadData().meals.length, 0);
    storage.clear();
    storage.set('leanwise-demo-v1', JSON.stringify({ version: 1, data: sampleData() }));
    assert.equal(loadData().meals.length, 0, 'old demo samples are not loaded');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: () => { throw new Error('quota exceeded'); } } });
    assert.throws(() => saveData(data), /无法保存记录/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
