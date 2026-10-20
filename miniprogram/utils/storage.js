const { storageKeys } = require('../config');
const units = ['g', 'ml', '个', '份', '杯', '碗', '片', '勺', '枚'];
const nutrientFields = ['kcal', 'protein', 'carbs', 'fat'];
const defaultProfile = { name: '', age: null, height: null, sex: 'female', activity: 1.2, startWeight: null, targetWeight: null, dailyTarget: 1800 };

function getArray(key) { const value = wx.getStorageSync(key); return Array.isArray(value) ? value : []; }
function getRecords() { return getArray(storageKeys.records); }
function saveRecords(records) { wx.setStorageSync(storageKeys.records, records); }
function getProducts() { return getArray(storageKeys.products); }
function getRecipes() { return getArray(storageKeys.recipes); }
function getWeights() { return getArray(storageKeys.weights); }
function getProfile() { return { ...defaultProfile, ...(wx.getStorageSync(storageKeys.profile) || {}) }; }
function getPreferences() { return { energyMode: 'estimate', healthSource: 'xiaomi', ...(wx.getStorageSync(storageKeys.preferences) || {}) }; }
function today() {
  const d = new Date(Date.now() + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function currentTime() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16); }
function uid() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function round(value) { return Math.round(value * 10) / 10; }
function validItem(item) {
  return item && typeof item.name === 'string' && item.name.trim() && units.includes(item.unit) && item.unit === item.baseUnit
    && ['quantity', 'baseQuantity'].every(k => Number.isFinite(Number(item[k])) && Number(item[k]) > 0 && Number(item[k]) <= 100000)
    && nutrientFields.every(k => item[k] !== '' && item[k] != null && Number.isFinite(Number(item[k])) && Number(item[k]) >= 0 && Number(item[k]) <= 100000);
}
function itemTotals(item) {
  const ratio = Number(item.quantity) / Number(item.baseQuantity);
  return nutrientFields.reduce((result, key) => ({ ...result, [key]: round(Number(item[key]) * ratio) }), {});
}
function snapshotItem(item) {
  const totals = itemTotals(item);
  return { ...item, name: item.name.trim(), quantity: Number(item.quantity), baseQuantity: Number(item.baseQuantity),
    ...nutrientFields.reduce((result, key) => ({ ...result, [key]: Number(item[key]) }), {}),
    kcalTotal: totals.kcal, proteinTotal: totals.protein, carbsTotal: totals.carbs, fatTotal: totals.fat };
}
function totalMeals(records) {
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  records.forEach(meal => (meal.items || []).forEach(item => {
    const values = validItem(item) ? itemTotals(item) : { kcal: Number(item.kcalTotal || 0), protein: Number(item.proteinTotal || 0), carbs: Number(item.carbsTotal || 0), fat: Number(item.fatTotal || 0) };
    nutrientFields.forEach(key => { totals[key] += values[key]; });
  }));
  nutrientFields.forEach(key => { totals[key] = round(totals[key]); });
  return totals;
}
function rememberItems(items, products) {
  const next = products.map(product => ({ ...product }));
  const linkedItems = items.map(item => {
    let index = next.findIndex(product => product.id === item.productId && product.name === item.name && product.unit === item.unit);
    if (index < 0) index = next.findIndex(product => product.name === item.name && product.unit === item.unit);
    const old = index >= 0 ? next[index] : null;
    const product = { ...(old || {}), id: old ? old.id : uid(), name: item.name, aliases: old ? (old.aliases || [item.name]) : [item.name],
      baseQuantity: item.baseQuantity, unit: item.unit, baseUnit: item.unit, source: '用户确认', version: old ? Number(old.version || 1) + 1 : 1,
      updatedAt: new Date().toISOString(), ...nutrientFields.reduce((result, key) => ({ ...result, [key]: Number(item[key]) }), {}) };
    if (index >= 0) next[index] = product; else next.push(product);
    return { ...item, productId: product.id };
  });
  return { products: next, items: linkedItems };
}
function expandRecipe(recipe, products) {
  return recipe.items.map(item => {
    const product = products.find(value => value.id === item.productId);
    if (!product) return { ...item, id: uid() };
    return { ...item, id: uid(), name: product.name, baseQuantity: product.baseQuantity, unit: product.unit, baseUnit: product.unit,
      ...nutrientFields.reduce((result, key) => ({ ...result, [key]: product[key] }), {}), source: 'memory', confidence: 'high' };
  });
}
function estimatedEnergy(profile, weights) {
  const latest = weights.filter(weight => weight.date <= today()).slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const weight = latest ? latest.value : profile.startWeight;
  if (!(weight > 0 && profile.height > 0 && profile.age > 0)) return null;
  const bmr = 10 * weight + 6.25 * profile.height - 5 * profile.age + (profile.sex === 'male' ? 5 : -161);
  return { bmr: Math.round(bmr), fullDayExpenditure: Math.round(bmr * profile.activity) };
}
function advisorContext() {
  const records = getRecords().slice().sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const day = today();
  const todayRecords = records.filter(meal => meal.date === day);
  const profile = getProfile();
  const weights = getWeights().filter(weight => weight.date <= day).sort((a, b) => a.date.localeCompare(b.date)).slice(-28);
  const completedDates = getArray(storageKeys.completedDates);
  const recentDates = [...new Set(records.map(meal => meal.date))].filter(date => date <= day).slice(0, 14).sort();
  const preferences = getPreferences();
  const selectedHealth = getArray(storageKeys.health).find(sample => sample.source === preferences.healthSource && sample.date === day) || null;
  const withoutPhoto = ({ photo, ...meal }) => meal;
  return { currentTime: new Date().toISOString(), timezone: 'Asia/Shanghai', date: day, profile,
    today: { totals: totalMeals(todayRecords), meals: todayRecords.map(withoutPhoto), complete: completedDates.includes(day), description: '截至目前已记录；仅标记完整的日期可分析全天摄入' },
    recentDays: recentDates.map(date => ({ date, totals: totalMeals(records.filter(meal => meal.date === date)), complete: completedDates.includes(date) })),
    recentRecords: records.filter(meal => meal.date <= day).slice(0, 28).map(withoutPhoto), weights,
    target: { dailyKcal: profile.dailyTarget, targetWeight: profile.targetWeight },
    energy: { mode: preferences.energyMode, estimate: estimatedEnergy(profile, weights), selectedHealth, fullDayBudget: profile.dailyTarget,
      budgetRule: '每日目标固定，切换消耗来源不改变摄入预算；设备活动热量不是全天总消耗。所有 health 数据都是演示，不作真实建议依据。' },
    dataCompleteness: { today: completedDates.includes(day), note: '本机记录；缺少记录不表示零摄入，未设置的资料为 null。' } };
}
function ensureAiConsent() {
  if (wx.getStorageSync(storageKeys.aiConsent)) return Promise.resolve(true);
  return new Promise(resolve => wx.showModal({ title: '使用 AI 服务', content: '食物解析会将你输入的文字和个人食品/配方记忆发送至 Leanwise 服务器，再由 DeepSeek 处理。顾问会接收本机已记录的饮食、目标、体重及演示消耗摘要。照片只保存在本机用于核对。是否继续？',
    confirmText: '同意并继续', success(result) { if (result.confirm) wx.setStorageSync(storageKeys.aiConsent, true); resolve(result.confirm); }, fail() { resolve(false); } }));
}
function savePhoto(path) {
  if (!path) return Promise.resolve('');
  return new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({ tempFilePath: path, success: result => resolve(result.savedFilePath), fail: reject }));
}
function removePhoto(path) { if (path) wx.getFileSystemManager().removeSavedFile({ filePath: path, fail() {} }); }
function commit(values) {
  const previous = {};
  const written = [];
  try {
    Object.keys(values).forEach(name => {
      const key = storageKeys[name];
      previous[key] = wx.getStorageSync(key);
      wx.setStorageSync(key, values[name]);
      written.push(key);
    });
  } catch (error) {
    written.reverse().forEach(key => { try { wx.setStorageSync(key, previous[key]); } catch (_) {} });
    throw error;
  }
}
function validateBackup(backup) {
  const data = backup && backup.data;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today() && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!backup || backup.format !== 'leanwise-miniprogram' || backup.version !== 1 || !data || typeof data !== 'object') throw new Error('Invalid backup');
  if (!['records', 'products', 'recipes', 'weights', 'health', 'completedDates'].every(key => Array.isArray(data[key]) && data[key].length <= 5000)) throw new Error('Invalid lists');
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
  if (!data.records.every(meal => validId(meal.id) && validDate(meal.date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(meal.time) && Array.isArray(meal.items) && meal.items.length > 0 && meal.items.length <= 30 && meal.items.every(validItem))) throw new Error('Invalid records');
  if (!data.products.every(product => validId(product.id) && validItem({ ...product, quantity: product.baseQuantity, baseUnit: product.unit }))) throw new Error('Invalid products');
  if (!data.recipes.every(recipe => validId(recipe.id) && typeof recipe.name === 'string' && recipe.name.trim() && Array.isArray(recipe.items) && recipe.items.length <= 30 && recipe.items.every(validItem))) throw new Error('Invalid recipes');
  if (!data.weights.every(weight => validId(weight.id) && validDate(weight.date) && Number.isFinite(weight.value) && weight.value >= 30 && weight.value <= 300)) throw new Error('Invalid weights');
  if (!data.completedDates.every(validDate)) throw new Error('Invalid completeness');
  const profile = { ...defaultProfile, ...data.profile };
  if (!Number.isFinite(profile.dailyTarget) || profile.dailyTarget < 1200 || profile.dailyTarget > 5000 || ![1.2, 1.375, 1.5, 1.725].includes(profile.activity) || !['female', 'male'].includes(profile.sex)) throw new Error('Invalid profile');
  const range = (value, minimum, maximum) => value == null || (Number.isFinite(value) && value >= minimum && value <= maximum);
  if (!range(profile.age, 18, 100) || !range(profile.height, 120, 230) || !range(profile.startWeight, 30, 300) || !range(profile.targetWeight, 30, 300)) throw new Error('Invalid profile range');
  const preferences = { energyMode: 'estimate', healthSource: 'xiaomi', ...data.preferences };
  if (!['estimate', 'device'].includes(preferences.energyMode) || !['xiaomi', 'huawei'].includes(preferences.healthSource)) throw new Error('Invalid preferences');
  if (!data.health.every(sample => sample.demo === true && ['xiaomi', 'huawei'].includes(sample.source) && validDate(sample.date) && Number.isFinite(sample.activeCalories) && sample.activeCalories >= 0)) throw new Error('Invalid health');
  return { records: data.records.map(({ photo, ...meal }) => ({ ...meal, items: meal.items.map(snapshotItem), kcal: Math.round(totalMeals([meal]).kcal) })),
    products: data.products, recipes: data.recipes, weights: data.weights, health: data.health.map(sample => ({ ...sample, demo: true, connected: false })),
    completedDates: [...new Set(data.completedDates)], profile, preferences };
}
module.exports = { storageKeys, units, defaultProfile, getArray, getRecords, saveRecords, getProducts, getRecipes, getWeights, getProfile,
  getPreferences, today, currentTime, uid, round, validItem, itemTotals, snapshotItem, totalMeals, rememberItems, expandRecipe, estimatedEnergy, advisorContext,
  ensureAiConsent, savePhoto, removePhoto, commit, validateBackup };
