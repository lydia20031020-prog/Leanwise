export type FoodUnit = 'g' | 'ml' | '个';

export interface Nutrients {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface FoodProduct extends Nutrients {
  id: string;
  name: string;
  brand?: string;
  aliases: string[];
  unit: FoodUnit;
  baseQuantity: number;
  source: string;
  version: number;
}

/** Nutrition is a snapshot per baseQuantity/baseUnit, never a serving total. */
export interface MealItem extends Nutrients {
  id: string;
  productId?: string;
  name: string;
  quantity: number;
  unit: string;
  baseQuantity: number;
  baseUnit: string;
  source: string;
  confidence?: string;
}

export interface Meal {
  id: string;
  date: string;
  time: string;
  type: '早餐' | '午餐' | '晚餐' | '加餐';
  items: MealItem[];
  note?: string;
  photo?: string;
}

export interface Recipe {
  id: string;
  name: string;
  aliases: string[];
  items: MealItem[];
}

export interface Weight {
  id: string;
  date: string;
  value: number;
}

export interface Profile {
  name: string;
  age: number;
  height: number;
  sex: 'female' | 'male';
  activity: number;
  startWeight: number;
  targetWeight: number;
  dailyTarget: number;
  targetDeficit: number;
}

export interface HealthSample {
  source: 'xiaomi' | 'huawei';
  activeCalories: number;
  syncedAt: string;
  coverageUntil: string;
  demo: true;
}

export interface AppData {
  profile: Profile;
  meals: Meal[];
  products: FoodProduct[];
  recipes: Recipe[];
  weights: Weight[];
  completedDates: string[];
  health: HealthSample[];
  energyMode: 'estimate' | 'device';
  healthSource: 'xiaomi' | 'huawei';
}

const STORAGE_KEY = 'leanwise-demo-v1';
const STORAGE_VERSION = 1;
const SHANGHAI = 'Asia/Shanghai';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const today = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const round = (value: number): number => Math.round(value * 10) / 10;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const emptyTotals = (): Nutrients => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

export function itemTotals(item: MealItem): Nutrients {
  if (!nonnegative(item.quantity) || !positive(item.baseQuantity)) return emptyTotals();
  const ratio = item.quantity / item.baseQuantity;
  return {
    kcal: (nonnegative(item.kcal) ? item.kcal : 0) * ratio,
    protein: (nonnegative(item.protein) ? item.protein : 0) * ratio,
    carbs: (nonnegative(item.carbs) ? item.carbs : 0) * ratio,
    fat: (nonnegative(item.fat) ? item.fat : 0) * ratio,
  };
}

function sumTotals(values: Nutrients[]): Nutrients {
  const sum = values.reduce((acc, val) => ({
    kcal: acc.kcal + val.kcal,
    protein: acc.protein + val.protein,
    carbs: acc.carbs + val.carbs,
    fat: acc.fat + val.fat,
  }), emptyTotals());
  return { kcal: round(sum.kcal), protein: round(sum.protein), carbs: round(sum.carbs), fat: round(sum.fat) };
}

export const mealTotals = (meal: Meal): Nutrients => sumTotals(meal.items.map(itemTotals));
export const dayTotals = (data: AppData, date: string): Nutrients =>
  sumTotals(data.meals.filter(meal => meal.date === date).flatMap(meal => meal.items.map(itemTotals)));

/** Mifflin–St Jeor estimate; a full-day estimate, not a live device measurement. */
export function bmr(profile: Profile, weight = profile.startWeight): number {
  return Math.round(10 * weight + 6.25 * profile.height - 5 * profile.age + (profile.sex === 'male' ? 5 : -161));
}

export function estimateTdee(profile: Profile, weight = profile.startWeight): number {
  return Math.round(bmr(profile, weight) * profile.activity);
}

function relativeDate(daysAgo: number): string {
  const date = new Date(`${today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function productItem(product: FoodProduct, quantity: number): MealItem {
  return {
    id: uid(), productId: product.id, name: product.name,
    quantity, unit: product.unit, baseQuantity: product.baseQuantity, baseUnit: product.unit,
    kcal: product.kcal, protein: product.protein, carbs: product.carbs, fat: product.fat,
    source: product.source, confidence: '营养来源已注明，份量需确认',
  };
}

export function initialData(): AppData {
  const products: FoodProduct[] = [
    { id: 'milk-own', name: '我的全脂牛奶', brand: '示例标签', aliases: ['我的牛奶', '全脂牛奶', '牛奶'], unit: 'ml', baseQuantity: 240, kcal: 160, protein: 9, carbs: 11, fat: 9, source: '个人食品 · 示例营养标签（每 240 ml）', version: 1 },
    { id: 'coffee', name: '无糖黑咖啡', aliases: ['黑咖啡', '美式咖啡', '咖啡'], unit: 'ml', baseQuantity: 100, kcal: 1, protein: 0.1, carbs: 0, fat: 0, source: '通用食品参考值', version: 1 },
    { id: 'egg', name: '煮鸡蛋', aliases: ['煮鸡蛋', '水煮蛋', '鸡蛋'], unit: '个', baseQuantity: 1, kcal: 78, protein: 6.3, carbs: 0.6, fat: 5.3, source: '通用参考 · 可食部分约 50 g / 个', version: 1 },
    { id: 'rice', name: '熟米饭', aliases: ['熟米饭', '米饭', '白饭'], unit: 'g', baseQuantity: 100, kcal: 116, protein: 2.6, carbs: 25.9, fat: 0.3, source: '通用食品参考值 · 熟重', version: 1 },
    { id: 'sweet-potato', name: '蒸红薯', aliases: ['蒸红薯', '红薯', '地瓜'], unit: 'g', baseQuantity: 100, kcal: 86, protein: 1.6, carbs: 20.1, fat: 0.1, source: '通用食品参考值 · 熟重', version: 1 },
    { id: 'chicken', name: '熟鸡胸肉', aliases: ['熟鸡胸肉', '鸡胸肉', '鸡肉'], unit: 'g', baseQuantity: 100, kcal: 165, protein: 31, carbs: 0, fat: 3.6, source: '通用食品参考值 · 未计额外烹饪油', version: 1 },
    { id: 'pork', name: '瘦猪肉', aliases: ['瘦猪肉', '猪里脊', '猪肉'], unit: 'g', baseQuantity: 100, kcal: 143, protein: 20.3, carbs: 1.5, fat: 6.2, source: '通用食品参考值 · 未计额外烹饪油', version: 1 },
    { id: 'salad', name: '生菜蔬菜', aliases: ['生菜蔬菜', '蔬菜沙拉', '沙拉', '生菜', '蔬菜'], unit: 'g', baseQuantity: 100, kcal: 25, protein: 1.5, carbs: 4, fat: 0.3, source: '通用食品参考值 · 不含沙拉酱', version: 1 },
    { id: 'oil', name: '烹饪油', aliases: ['橄榄油', '食用油', '烹饪油', '油'], unit: 'g', baseQuantity: 100, kcal: 884, protein: 0, carbs: 0, fat: 100, source: '通用食品参考值', version: 1 },
    { id: 'oats', name: '原味燕麦', aliases: ['原味燕麦', '燕麦片', '燕麦'], unit: 'g', baseQuantity: 100, kcal: 389, protein: 16.9, carbs: 66.3, fat: 6.9, source: '通用食品参考值 · 干重', version: 1 },
    { id: 'tofu', name: '北豆腐', aliases: ['北豆腐', '豆腐'], unit: 'g', baseQuantity: 100, kcal: 81, protein: 8.1, carbs: 1.9, fat: 4.2, source: '通用食品参考值', version: 1 },
    { id: 'yogurt', name: '原味酸奶', aliases: ['原味酸奶', '酸奶'], unit: 'g', baseQuantity: 100, kcal: 70, protein: 4, carbs: 7, fat: 2.8, source: '通用食品参考值', version: 1 },
    { id: 'nuts', name: '混合坚果', aliases: ['混合坚果', '坚果'], unit: 'g', baseQuantity: 100, kcal: 600, protein: 20, carbs: 20, fat: 52, source: '通用食品参考值', version: 1 },
  ];
  const get = (id: string, amount: number) => productItem(products.find(product => product.id === id)!, amount);
  const meals: Meal[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = relativeDate(i);
    meals.push({ id: uid(), date, time: '08:15', type: '早餐', items: [get('milk-own', 150), get('coffee', 150), get('egg', 1), get('oats', 40 + (i % 3) * 5)], note: '演示记录 · 咖啡牛奶、鸡蛋和燕麦' });
    meals.push({ id: uid(), date, time: '12:30', type: '午餐', items: [get('rice', 150 + (i % 3) * 15), get('chicken', 140), get('salad', 200), get('oil', 8)], note: '演示记录 · 烹饪油已单独计入' });
    if (i > 0) {
      meals.push({ id: uid(), date, time: '18:40', type: '晚餐', items: [get('sweet-potato', 200), get('tofu', 180), get('pork', 80), get('salad', 180), get('oil', 6)], note: '演示记录' });
      meals.push({ id: uid(), date, time: '15:30', type: '加餐', items: [get('yogurt', 150), get('nuts', 20 + (i % 2) * 5)], note: '演示记录' });
    }
  }
  const now = new Date();
  const syncedAt = new Date(now.getTime() - 32 * 60 * 1000).toISOString();
  const coverageUntil = new Date(now.getTime() - 45 * 60 * 1000).toISOString();
  return {
    profile: { name: '林可', age: 28, height: 165, sex: 'female', activity: 1.5, startWeight: 68, targetWeight: 62, dailyTarget: 1750, targetDeficit: 300 },
    meals,
    products,
    recipes: [{ id: 'coffee-milk', name: '咖啡牛奶', aliases: ['咖啡牛奶', '我的咖啡牛奶', '牛奶咖啡'], items: [get('milk-own', 150), get('coffee', 150)] }],
    weights: [
      { id: uid(), date: relativeDate(13), value: 68 },
      { id: uid(), date: relativeDate(11), value: 67.8 },
      { id: uid(), date: relativeDate(9), value: 67.9 },
      { id: uid(), date: relativeDate(7), value: 67.5 },
      { id: uid(), date: relativeDate(5), value: 67.6 },
      { id: uid(), date: relativeDate(3), value: 67.3 },
      { id: uid(), date: relativeDate(1), value: 67.2 },
      { id: uid(), date: relativeDate(0), value: 67.3 },
    ],
    completedDates: Array.from({ length: 13 }, (_, i) => relativeDate(i + 1)).filter((_, i) => i !== 4 && i !== 9),
    health: [
      { source: 'xiaomi', activeCalories: 426, syncedAt, coverageUntil, demo: true },
      { source: 'huawei', activeCalories: 398, syncedAt, coverageUntil, demo: true },
    ],
    energyMode: 'estimate', healthSource: 'xiaomi',
  };
}

function validNutrients(value: Record<string, unknown>): boolean {
  return ['kcal', 'protein', 'carbs', 'fat'].every(key => nonnegative(value[key]));
}

function validItem(value: unknown): value is MealItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as unknown as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.name === 'string' &&
    nonnegative(item.quantity) && positive(item.baseQuantity) &&
    typeof item.unit === 'string' && item.unit === item.baseUnit &&
    typeof item.source === 'string' && validNutrients(item);
}

function validProduct(value: unknown): value is FoodProduct {
  if (!value || typeof value !== 'object') return false;
  const product = value as unknown as Record<string, unknown>;
  return typeof product.id === 'string' && typeof product.name === 'string' &&
    Array.isArray(product.aliases) && product.aliases.every(alias => typeof alias === 'string') &&
    ['g', 'ml', '个'].includes(product.unit as string) && positive(product.baseQuantity) &&
    typeof product.source === 'string' && positive(product.version) && validNutrients(product);
}

/** A damaged record is discarded independently; valid user records remain usable. */
export function loadData(): AppData {
  const seed = initialData();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed;
    const stored = JSON.parse(raw);
    if (stored.version !== STORAGE_VERSION || !stored.data || typeof stored.data !== 'object') return seed;
    const data = stored.data as AppData;
    const validProfile = data.profile && typeof data.profile.name === 'string' &&
      ['female', 'male'].includes(data.profile.sex) &&
      ['age', 'height', 'activity', 'startWeight', 'targetWeight', 'dailyTarget'].every(key => positive((data.profile as unknown as Record<string, unknown>)[key])) &&
      nonnegative(data.profile.targetDeficit);
    const meals = Array.isArray(data.meals) ? data.meals.filter(meal =>
      meal && typeof meal.id === 'string' && DATE_PATTERN.test(meal.date) && /^\d{2}:\d{2}$/.test(meal.time) &&
      ['早餐', '午餐', '晚餐', '加餐'].includes(meal.type) && Array.isArray(meal.items) && meal.items.every(validItem)) : seed.meals;
    return {
      profile: validProfile ? data.profile : seed.profile,
      meals,
      products: Array.isArray(data.products) ? data.products.filter(validProduct) : seed.products,
      recipes: Array.isArray(data.recipes) ? data.recipes.filter(recipe =>
        recipe && typeof recipe.id === 'string' && typeof recipe.name === 'string' &&
        Array.isArray(recipe.aliases) && recipe.aliases.every(alias => typeof alias === 'string') &&
        Array.isArray(recipe.items) && recipe.items.every(validItem)) : seed.recipes,
      weights: Array.isArray(data.weights) ? data.weights.filter(weight =>
        weight && typeof weight.id === 'string' && DATE_PATTERN.test(weight.date) && positive(weight.value)) : seed.weights,
      completedDates: Array.isArray(data.completedDates) ? data.completedDates.filter(date => typeof date === 'string' && DATE_PATTERN.test(date)) : [],
      health: Array.isArray(data.health) ? data.health.filter(sample =>
        sample && ['xiaomi', 'huawei'].includes(sample.source) && nonnegative(sample.activeCalories) &&
        typeof sample.syncedAt === 'string' && typeof sample.coverageUntil === 'string' && sample.demo === true) : seed.health,
      energyMode: data.energyMode === 'device' ? 'device' : 'estimate',
      healthSource: data.healthSource === 'huawei' ? 'huawei' : 'xiaomi',
    };
  } catch {
    return seed;
  }
}

/** Throws a readable error if the browser cannot persist; the UI must surface it. */
export function saveData(data: AppData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, data }));
  } catch {
    throw new Error('当前浏览器无法保存记录，请检查存储空间或隐私模式。');
  }
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quantityToken = '(\\d+(?:\\.\\d+)?|半|[一二两三四五六七八九十]+)';
const unitToken = '(千克|公斤|毫升|克|kg|ml|g|升|l|个|只|颗|杯|碗|份|片|根|块)';
const CHINESE_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function numeric(value: string): number {
  if (value === '半') return 0.5;
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (tens ? CHINESE_DIGITS[tens] || 0 : 1) * 10 + (ones ? CHINESE_DIGITS[ones] || 0 : 0);
  }
  return CHINESE_DIGITS[value] ?? Number(value);
}

interface ParsedQuantity { amount: number; unit: string; span: [number, number] }

function quantityNear(text: string, alias: string): ParsedQuantity | null {
  const name = escapeRegex(alias);
  const after = new RegExp(`${name}[\\s:：约大概]*${quantityToken}\\s*${unitToken}`, 'i');
  const before = new RegExp(`${quantityToken}\\s*${unitToken}[\\s的]*${name}`, 'i');
  const matchAfter = after.exec(text);
  const matchBefore = before.exec(text);
  const match = matchAfter ?? matchBefore;
  if (!match || match.index === undefined) return null;
  const amount = numeric(match[1]);
  if (!nonnegative(amount)) return null;
  return { amount, unit: match[2].toLowerCase(), span: [match.index, match.index + match[0].length] };
}

function quantityInBase(parsed: ParsedQuantity, unit: string, fallbackPortion: number): number | null {
  const { amount, unit: inputUnit } = parsed;
  if (['千克', '公斤', 'kg'].includes(inputUnit)) return unit === 'g' ? amount * 1000 : null;
  if (['克', 'g'].includes(inputUnit)) return unit === 'g' ? amount : unit === '个' ? amount / 50 : null;
  if (['毫升', 'ml'].includes(inputUnit)) return unit === 'ml' ? amount : null;
  if (['升', 'l'].includes(inputUnit)) return unit === 'ml' ? amount * 1000 : null;
  if (['个', '只', '颗'].includes(inputUnit) && unit === '个') return amount;
  if (['杯', '碗', '份', '片', '根', '块', '个', '只', '颗'].includes(inputUnit)) return amount * fallbackPortion;
  return null;
}

const DEFAULT_PORTIONS: Record<string, number> = {
  'milk-own': 250, coffee: 150, egg: 1, rice: 150, 'sweet-potato': 150,
  chicken: 120, pork: 100, salad: 150, oil: 5, oats: 40, tofu: 150, yogurt: 150, nuts: 20,
};

const maskSpan = (text: string, span: [number, number]): string =>
  text.slice(0, span[0]) + ' '.repeat(span[1] - span[0]) + text.slice(span[1]);

/**
 * Refresh a future draft only from an already matched productId. Never guesses a
 * brand from a generic name, and never mutates the supplied historic snapshots.
 */
export function applyConfirmedMemory(
  items: MealItem[],
  memory: Pick<AppData, 'products'>,
  text = '',
): MealItem[] {
  return items.map(original => {
    const product = memory.products.find(candidate => candidate.id === original.productId);
    if (!product || product.unit !== original.unit || ['label', 'database', 'estimate'].includes(original.source)) return { ...original };
    const updated = {
      ...original,
      name: product.name,
      baseQuantity: product.baseQuantity,
      baseUnit: product.unit,
      kcal: product.kcal,
      protein: product.protein,
      carbs: product.carbs,
      fat: product.fat,
      source: product.source,
    };
    const aliases = [...new Set([product.name, ...product.aliases])].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const specified = quantityNear(text, alias);
      if (!specified) continue;
      const quantity = quantityInBase(specified, product.unit, DEFAULT_PORTIONS[product.id] ?? original.quantity);
      if (quantity !== null) updated.quantity = round(quantity);
      break;
    }
    return updated;
  });
}

/** Transparent demo fallback. It never claims that a local rule is an AI answer. */
export function resolveLocalMeal(text: string, data: AppData): { items: MealItem[]; note: string } | null {
  let remaining = text.trim();
  if (!remaining) return null;
  // Local fallback cannot verify an unfamiliar brand. It must not silently use
  // the user's usual milk when this input explicitly names a replacement.
  const mentionedBrands = [
    ...(text.match(/(?:[A-Za-z0-9]{1,16}|[\u4e00-\u9fa5]{1,8})品牌/g) ?? []).map(value => value.replace(/品牌$/, '')),
    ...(text.match(/蒙牛|伊利|光明|特仑苏|金典|安慕希|旺仔|德亚|欧德堡|认养一头牛/g) ?? []),
  ];
  if (mentionedBrands.some(brand => !data.products.some(product =>
    [product.brand ?? '', product.name, ...product.aliases].some(name => name.includes(brand))))) return null;
  if (mentionedBrands.length && data.recipes.some(recipe =>
    [recipe.name, ...recipe.aliases].some(alias => text.includes(alias)) &&
    mentionedBrands.some(brand => ![recipe.name, ...recipe.aliases].some(alias => alias.includes(brand))))) return null;
  const items: MealItem[] = [];
  const notes: string[] = ['本地规则解析 · 尚未调用 AI；请确认食品、份量和遗漏的调料。'];
  const recipes = [...data.recipes].sort((a, b) => b.name.length - a.name.length);

  for (const recipe of recipes) {
    const aliases = [...new Set([recipe.name, ...recipe.aliases])].filter(Boolean).sort((a, b) => b.length - a.length);
    const alias = aliases.find(name => remaining.includes(name));
    if (!alias) continue;
    const index = remaining.indexOf(alias);
    const specified = quantityNear(remaining, alias);
    const recipeVolume = recipe.items.filter(item => item.unit === 'ml').reduce((sum, item) => sum + item.quantity, 0);
    const recipeMass = recipe.items.filter(item => item.unit === 'g').reduce((sum, item) => sum + item.quantity, 0);
    let scale = 1;
    if (specified) {
      if (['ml', '毫升', 'l', '升'].includes(specified.unit) && recipeVolume > 0) {
        scale = specified.amount * (['l', '升'].includes(specified.unit) ? 1000 : 1) / recipeVolume;
      } else if (['g', '克', 'kg', '公斤', '千克'].includes(specified.unit) && recipeMass > 0) {
        scale = specified.amount * (['kg', '公斤', '千克'].includes(specified.unit) ? 1000 : 1) / recipeMass;
      } else if (['份', '杯', '碗'].includes(specified.unit)) scale = specified.amount;
      else notes.push(`“${recipe.name}”的单位未能换算，保留常用配方份量，请调整。`);
    }
    remaining = maskSpan(remaining, specified?.span ?? [index, index + alias.length]);
    const recipeItems = recipe.items.map(saved => {
      const product = data.products.find(candidate => candidate.id === saved.productId);
      // Refresh future uses from the current personal product; past MealItems stay immutable.
      const item = product ? productItem(product, round(saved.quantity * scale)) : { ...saved, id: uid(), quantity: round(saved.quantity * scale) };
      const ingredientAliases = [...new Set([item.name, ...(product?.aliases ?? [])])].sort((a, b) => b.length - a.length);
      for (const ingredient of ingredientAliases) {
        const override = quantityNear(remaining, ingredient);
        if (!override) continue;
        const quantity = quantityInBase(override, item.unit, saved.quantity);
        if (quantity !== null) {
          item.quantity = round(quantity);
          notes.push(`${item.name}使用本次明确份量 ${round(quantity)} ${item.unit}。`);
          remaining = maskSpan(remaining, override.span);
        } else {
          notes.push(`${item.name}的单位无法直接换算，请手动确认。`);
        }
        break;
      }
      item.confidence = '已匹配个人配方 · 请确认本次份量';
      return item;
    });
    items.push(...recipeItems);
    notes.push(`已复用个人配方“${recipe.name}”，营养使用当前个人食品数据。`);
  }

  const matchLength = (product: FoodProduct): number => Math.max(0,
    ...[product.name, ...product.aliases].filter(alias => alias && remaining.includes(alias)).map(alias => alias.length));
  const products = [...data.products].sort((a, b) => matchLength(b) - matchLength(a));
  for (const product of products) {
    const aliases = [...new Set([product.name, ...product.aliases])].filter(Boolean).sort((a, b) => b.length - a.length);
    const alias = aliases.find(name => remaining.includes(name));
    if (!alias) continue;
    // A bare “油” in “油炸/油煎/油条” is a cooking method, not an oil quantity.
    if (alias === '油' && !quantityNear(remaining, alias) && /油[炸煎条]/.test(remaining)) continue;
    const index = remaining.indexOf(alias);
    const specified = quantityNear(remaining, alias);
    const defaultPortion = DEFAULT_PORTIONS[product.id] ?? (product.unit === '个' ? 1 : product.baseQuantity);
    const parsedAmount = specified ? quantityInBase(specified, product.unit, defaultPortion) : null;
    const amount = parsedAmount ?? defaultPortion;
    items.push(productItem(product, round(amount)));
    remaining = maskSpan(remaining, specified?.span ?? [index, index + alias.length]);
    if (!specified) notes.push(`${product.name}未明确份量，暂按 ${amount} ${product.unit} 估算。`);
    if (specified && parsedAmount === null) notes.push(`${product.name}的单位无法直接换算，暂按 ${amount} ${product.unit}，请调整。`);
  }
  if (items.length === 0) return null;
  if (/炒|煎|炸|酱|糖|沙拉/.test(text) && !items.some(item => item.productId === 'oil')) {
    notes.push('烹饪油、糖和酱料未自动计入；如有使用，请补充。');
  }
  notes.push('本地解析只覆盖示例食品，未识别的食物请手动补充；保存前逐项检查。');
  return { items, note: notes.join(' ') };
}

export function advisorContext(data: AppData, date: string) {
  const now = new Intl.DateTimeFormat('zh-CN', { timeZone: SHANGHAI, dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date());
  const recentDays = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - i);
    const key = day.toISOString().slice(0, 10);
    return { date: key, complete: data.completedDates.includes(key), recordedMeals: data.meals.filter(meal => meal.date === key).length, totals: dayTotals(data, key) };
  });
  const completeDays = recentDays.filter(day => day.complete && day.recordedMeals > 0);
  const latestWeight = [...data.weights].filter(weight => weight.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0]?.value ?? data.profile.startWeight;
  const selectedHealth = data.health.find(sample => sample.source === data.healthSource);
  const total = dayTotals(data, date);
  return {
    application: 'Leanwise 可运行演示',
    dataset: '浏览器内的演示数据与用户后续手动记录；设备样本始终是模拟值，并非厂商真实授权数据',
    currentTime: now,
    timezone: SHANGHAI,
    date,
    isComplete: data.completedDates.includes(date),
    profile: data.profile,
    todayTotals: total,
    remainingBudget: round(data.profile.dailyTarget - total.kcal),
    meals: data.meals.filter(meal => meal.date === date).map(meal => ({
      id: meal.id, type: meal.type, time: meal.time, note: meal.note,
      totals: mealTotals(meal),
      items: meal.items.map(item => ({ name: item.name, quantity: item.quantity, unit: item.unit, source: item.source, totals: itemTotals(item) })),
    })),
    recentDays,
    completeDayCount: completeDays.length,
    completeDayAverages: completeDays.length ? {
      kcal: round(completeDays.reduce((sum, day) => sum + day.totals.kcal, 0) / completeDays.length),
      protein: round(completeDays.reduce((sum, day) => sum + day.totals.protein, 0) / completeDays.length),
      carbs: round(completeDays.reduce((sum, day) => sum + day.totals.carbs, 0) / completeDays.length),
      fat: round(completeDays.reduce((sum, day) => sum + day.totals.fat, 0) / completeDays.length),
    } : null,
    weights: [...data.weights].filter(weight => weight.date <= date).sort((a, b) => a.date.localeCompare(b.date)).slice(-28),
    energy: {
      mode: data.energyMode,
      estimatedBmr: bmr(data.profile, latestWeight),
      estimatedFullDayExpenditure: estimateTdee(data.profile, latestWeight),
      fullDayBudget: data.profile.dailyTarget,
      budgetRule: '当前有效每日目标固定；切换设备视图不自动修改饮食预算',
      selectedHealth: selectedHealth ?? null,
      deviceRule: '设备展示模拟活动热量和覆盖截至时间，不是全天总消耗；不可叠加重复运动热量',
    },
    personalRecipes: data.recipes.map(recipe => ({ name: recipe.name, aliases: recipe.aliases, items: recipe.items.map(item => ({ name: item.name, quantity: item.quantity, unit: item.unit })) })),
    adviceRules: [
      '所有结论必须引用以上数据；不得编造记录。',
      '未标记完整的日期不能用于判断全天摄入不足；缺失记录不是零摄入。',
      '单日体重变化不能直接解释为脂肪变化。',
      '不要给固定低热量处方，也不要使用“节能模式”解释单日饮食。',
      '只能提出目标调整建议，不得自动修改目标。',
      '演示设备数据只能说明界面流程，不能据此做真实健康判断。',
    ],
  };
}
