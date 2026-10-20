const store = require('../../utils/storage');
Page({
  ...require('../../utils/privacy'),
  data: { date: store.today(), maxDate: store.today(), records: [], totals: {}, complete: false, importText: '', error: '', products: [], recipes: [], showPrivacy: false, privacyContractName: '小程序用户隐私保护指引', privacyError: '' },
  onShow() { this.refresh(); },
  onDate(e) { this.setData({ date: e.detail.value }); this.refresh(); },
  refresh() {
    const records = store.getRecords().filter(meal => meal.date === this.data.date).sort((a, b) => b.time.localeCompare(a.time));
    this.setData({ records, totals: store.totalMeals(records), complete: store.getArray(store.storageKeys.completedDates).includes(this.data.date),
      products: store.getProducts(), recipes: store.getRecipes() });
  },
  editMeal(e) { wx.navigateTo({ url: '/pages/record/record?editId=' + e.currentTarget.dataset.id }); },
  previewPhoto(e) { wx.previewImage({ urls: [e.currentTarget.dataset.path] }); },
  setComplete(e) {
    const dates = store.getArray(store.storageKeys.completedDates).filter(date => date !== this.data.date);
    if (e.detail.value) dates.push(this.data.date);
    try { wx.setStorageSync(store.storageKeys.completedDates, dates); this.refresh(); }
    catch (_) { this.setData({ error: '本机保存失败。' }); }
  },
  removeMeal(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '删除这餐？', content: '仅删除本机餐食记录和关联照片，食品/配方记忆保留。', success: result => {
      if (!result.confirm) return;
      const old = store.getRecords().find(meal => meal.id === id);
      try {
        store.commit({ records: store.getRecords().filter(meal => meal.id !== id), completedDates: store.getArray(store.storageKeys.completedDates).filter(date => date !== this.data.date) });
        if (old) store.removePhoto(old.photo);
        this.refresh();
      } catch (_) { this.setData({ error: '本机保存失败。' }); }
    } });
  },
  useRecipe(e) { wx.navigateTo({ url: '/pages/record/record?recipeId=' + e.currentTarget.dataset.id }); },
  removeRecipe(e) {
    wx.showModal({ title: '删除常用配方？', content: '历史记录与食品营养记忆保留。', success: result => {
      if (!result.confirm) return;
      try { wx.setStorageSync(store.storageKeys.recipes, store.getRecipes().filter(recipe => recipe.id !== e.currentTarget.dataset.id)); this.refresh(); }
      catch (_) { this.setData({ error: '本机保存失败。' }); }
    } });
  },
  exportData() {
    const records = store.getRecords().map(({ photo, ...meal }) => meal);
    const backup = { format: 'leanwise-miniprogram', version: 1, exportedAt: new Date().toISOString(), data: { records, profile: store.getProfile(),
      products: store.getProducts(), recipes: store.getRecipes(), weights: store.getWeights(), health: store.getArray(store.storageKeys.health),
      preferences: store.getPreferences(), completedDates: store.getArray(store.storageKeys.completedDates) } };
    wx.setClipboardData({ data: JSON.stringify(backup), success() { wx.showToast({ title: '备份已复制', icon: 'success' }); },
      fail: () => this.setData({ error: '复制失败，请重试。' }) });
  },
  onImport(e) { this.setData({ importText: e.detail.value }); },
  restoreData() {
    let backup;
    try { backup = store.validateBackup(JSON.parse(this.data.importText)); }
    catch (_) { return this.setData({ error: '备份格式或数据无效。请粘贴本小程序“复制记录备份”导出的完整 JSON。' }); }
    wx.showModal({ title: '用备份替换本机记录？', content: '当前饮食、食品、配方、目标和体重会被替换；照片不包含在文本备份中。请先复制当前备份。', success: result => {
      if (!result.confirm) return;
      const oldRecords = store.getRecords();
      try { store.commit(backup); oldRecords.forEach(meal => store.removePhoto(meal.photo)); this.setData({ importText: '', error: '' }); this.refresh(); wx.showToast({ title: '备份已恢复', icon: 'success' }); }
      catch (_) { this.setData({ error: '恢复失败，请释放本机空间后重试。' }); }
    } });
  },
  clearData() {
    wx.showModal({ title: '清空本机数据？', content: '将删除本小程序的饮食、照片、体重、目标、食品、配方和 AI 同意记录。此操作无法撤回，请先备份。', success: result => {
      if (!result.confirm) return;
      const oldRecords = store.getRecords();
      try {
        store.commit({ records: [], products: [], recipes: [], weights: [], health: [], completedDates: [], profile: { ...store.defaultProfile }, preferences: { energyMode: 'estimate', healthSource: 'xiaomi' }, aiConsent: false });
        oldRecords.forEach(meal => store.removePhoto(meal.photo));
        this.setData({ error: '' }); this.refresh(); wx.showToast({ title: '本机数据已清空', icon: 'success' });
      } catch (_) { this.setData({ error: '本机清空失败，请重试。' }); }
    } });
  },
  revokeConsent() { wx.removeStorageSync(store.storageKeys.aiConsent); wx.showToast({ title: '已撤回 AI 同意', icon: 'none' }); },
  privacyContract() { wx.openPrivacyContract({ fail: () => this.setData({ error: '隐私指引尚未在微信后台配置，请联系小程序管理员。' }) }); }
});
