const { getStatus, demoSync } = require('../../utils/api');
const store = require('../../utils/storage');
Page({
  data: { serviceLabel: '检测中', healthLabel: '未设置估算资料', healthTime: '', energyMode: 'estimate', target: 1800, remaining: 1800,
    todayRecords: [], recipes: [], summary: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, complete: false, syncing: false },
  onShow() { this.refresh(); this.checkStatus(); },
  refresh() {
    const records = store.getRecords().filter(item => item.date === store.today()).sort((a, b) => b.time.localeCompare(a.time));
    const profile = store.getProfile();
    const summary = store.totalMeals(records);
    const preferences = store.getPreferences();
    const estimate = store.estimatedEnergy(profile, store.getWeights());
    const health = store.getArray(store.storageKeys.health).find(sample => sample.source === preferences.healthSource && sample.date === store.today());
    let healthLabel = estimate ? '估算全天总消耗 ' + estimate.fullDayExpenditure + ' kcal' : '请在目标页补充身体资料以估算消耗';
    if (preferences.energyMode === 'device') healthLabel = health ? health.sourceName + ' · 模拟活动热量 ' + health.activeCalories + ' kcal' : '今日尚无演示设备数据';
    this.setData({ todayRecords: records, summary, target: profile.dailyTarget, remaining: Math.max(0, Math.round(profile.dailyTarget - summary.kcal)),
      recipes: store.getRecipes(), complete: store.getArray(store.storageKeys.completedDates).includes(store.today()),
      energyMode: preferences.energyMode, healthLabel, healthTime: preferences.energyMode === 'device' && health ? '模拟数据更新至 ' + new Date(Date.parse(health.syncedAt) + 8 * 3600000).toISOString().slice(11, 16) : '' });
  },
  async checkStatus() { try { const status = await getStatus(); this.setData({ serviceLabel: status.configured ? 'AI 已连接' : 'AI 未配置' }); } catch (_) { this.setData({ serviceLabel: '服务离线' }); } },
  goRecord() { wx.navigateTo({ url: '/pages/record/record' }); },
  goAdvisor() { wx.navigateTo({ url: '/pages/advisor/advisor' }); },
  goGoal() { wx.navigateTo({ url: '/pages/goal/goal' }); },
  goHistory() { wx.navigateTo({ url: '/pages/history/history' }); },
  useRecipe(e) { wx.navigateTo({ url: '/pages/record/record?recipeId=' + e.currentTarget.dataset.id }); },
  editMeal(e) { wx.navigateTo({ url: '/pages/record/record?editId=' + e.currentTarget.dataset.id }); },
  setEnergyMode(e) {
    try { wx.setStorageSync(store.storageKeys.preferences, { ...store.getPreferences(), energyMode: e.currentTarget.dataset.mode }); this.refresh(); }
    catch (_) { wx.showToast({ title: '本机保存失败', icon: 'none' }); }
  },
  setComplete(e) {
    const dates = store.getArray(store.storageKeys.completedDates).filter(date => date !== store.today());
    if (e.detail.value) dates.push(store.today());
    try { wx.setStorageSync(store.storageKeys.completedDates, dates); this.refresh(); }
    catch (_) { wx.showToast({ title: '本机保存失败', icon: 'none' }); }
  },
  async sync(source) {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    try {
      const result = await demoSync(source);
      const health = store.getArray(store.storageKeys.health).filter(sample => sample.source !== source || sample.date !== store.today());
      store.commit({ health: [...health, { ...result, date: store.today(), demo: true, connected: false }],
        preferences: { ...store.getPreferences(), healthSource: source, energyMode: 'device' } });
      this.refresh();
      wx.showToast({ title: '演示数据已保存', icon: 'none' });
    } catch (e) { wx.showToast({ title: e.message || '演示同步失败', icon: 'none' }); }
    finally { this.setData({ syncing: false }); }
  },
  syncXiaomi() { this.sync('xiaomi'); }, syncHuawei() { this.sync('huawei'); }
});
