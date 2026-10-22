import { initialData, today, uid, type AppData, type FoodProduct, type Meal, type MealItem } from '../src/model.ts';

// Test-only data. The app itself starts empty; these records exercise parsing,
// memory and history rules against a realistic two-week history.
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

export function sampleData(): AppData {
  const products: FoodProduct[] = [
    { id: 'milk-own', name: '我的全脂牛奶', brand: '测试标签', aliases: ['我的牛奶', '全脂牛奶', '牛奶'], unit: 'ml', baseQuantity: 240, kcal: 160, protein: 9, carbs: 11, fat: 9, source: '个人食品 · 营养标签（每 240 ml）', version: 1 },
    { id: 'coffee', name: '无糖黑咖啡', aliases: ['黑咖啡', '美式咖啡', '咖啡'], unit: 'ml', baseQuantity: 100, kcal: 1, protein: 0.1, carbs: 0, fat: 0, source: '通用食品参考值', version: 1 },
    { id: 'egg', name: '煮鸡蛋', aliases: ['煮鸡蛋', '水煮蛋', '鸡蛋'], unit: '个', baseQuantity: 1, kcal: 78, protein: 6.3, carbs: 0.6, fat: 5.3, source: '通用参考 · 可食部分约 50 g / 个', version: 1 },
    { id: 'rice', name: '熟米饭', aliases: ['熟米饭', '米饭', '白饭'], unit: 'g', baseQuantity: 100, kcal: 116, protein: 2.6, carbs: 25.9, fat: 0.3, source: '通用食品参考值 · 熟重', version: 1 },
    { id: 'chicken', name: '熟鸡胸肉', aliases: ['熟鸡胸肉', '鸡胸肉', '鸡肉'], unit: 'g', baseQuantity: 100, kcal: 165, protein: 31, carbs: 0, fat: 3.6, source: '通用食品参考值 · 未计额外烹饪油', version: 1 },
    { id: 'salad', name: '生菜蔬菜', aliases: ['生菜蔬菜', '蔬菜沙拉', '沙拉', '生菜', '蔬菜'], unit: 'g', baseQuantity: 100, kcal: 25, protein: 1.5, carbs: 4, fat: 0.3, source: '通用食品参考值 · 不含沙拉酱', version: 1 },
    { id: 'oil', name: '烹饪油', aliases: ['橄榄油', '食用油', '烹饪油', '油'], unit: 'g', baseQuantity: 100, kcal: 884, protein: 0, carbs: 0, fat: 100, source: '通用食品参考值', version: 1 },
    { id: 'oats', name: '原味燕麦', aliases: ['原味燕麦', '燕麦片', '燕麦'], unit: 'g', baseQuantity: 100, kcal: 389, protein: 16.9, carbs: 66.3, fat: 6.9, source: '通用食品参考值 · 干重', version: 1 },
  ];
  const get = (id: string, amount: number) => productItem(products.find(product => product.id === id)!, amount);
  const meals: Meal[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = relativeDate(i);
    meals.push({ id: uid(), date, time: '08:15', type: '早餐', items: [get('milk-own', 150), get('coffee', 150), get('egg', 1), get('oats', 40)] });
    meals.push({ id: uid(), date, time: '12:30', type: '午餐', items: [get('rice', 150), get('chicken', 140), get('salad', 200), get('oil', 8)] });
  }
  return {
    ...initialData(),
    profile: { name: '测试用户', age: 28, height: 165, sex: 'female', activity: 1.5, startWeight: 68, targetWeight: 62, dailyTarget: 1750, targetDeficit: 300 },
    meals,
    products,
    recipes: [{ id: 'coffee-milk', name: '咖啡牛奶', aliases: ['咖啡牛奶', '我的咖啡牛奶', '牛奶咖啡'], items: [get('milk-own', 150), get('coffee', 150)] }],
    weights: [{ id: uid(), date: relativeDate(13), value: 68 }, { id: uid(), date: relativeDate(0), value: 67.3 }],
    completedDates: Array.from({ length: 13 }, (_, i) => relativeDate(i + 1)),
  };
}
