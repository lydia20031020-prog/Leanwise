const store = require('../../utils/storage');
Page({
  data: { profile: {}, sexLabels: ['女性', '男性'], sexIndex: 0, activityLabels: ['久坐 · 1.2', '轻度活动 · 1.375', '一般活动 · 1.5', '高活动 · 1.725'],
    activityIndex: 0, weightValue: '', weightDate: store.today(), maxDate: store.today(), weights: [], chartWeights: [], delta: '', chartRange: '', error: '' },
  onShow() { this.refresh(); },
  refresh() {
    const profile = store.getProfile();
    const weights = store.getWeights().slice().sort((a, b) => a.date.localeCompare(b.date));
    const chartWeights = weights.slice(-14);
    const values = chartWeights.map(item => item.value);
    this.setData({ profile, sexIndex: profile.sex === 'male' ? 1 : 0, activityIndex: Math.max(0, [1.2, 1.375, 1.5, 1.725].indexOf(profile.activity)),
      weights: weights.slice().reverse(), chartWeights, delta: chartWeights.length >= 2 ? store.round(values[values.length - 1] - values[0]) : '',
      chartRange: values.length ? Math.min(...values) + '–' + Math.max(...values) + ' kg · ' + chartWeights[0].date + ' 至 ' + chartWeights[chartWeights.length - 1].date : '' });
    wx.nextTick(() => this.drawChart());
  },
  onField(e) { this.setData({ ['profile.' + e.currentTarget.dataset.field]: e.detail.value }); },
  onSex(e) { this.setData({ sexIndex: Number(e.detail.value), 'profile.sex': Number(e.detail.value) ? 'male' : 'female' }); },
  onActivity(e) { this.setData({ activityIndex: Number(e.detail.value), 'profile.activity': [1.2, 1.375, 1.5, 1.725][Number(e.detail.value)] }); },
  onWeight(e) { this.setData({ weightValue: e.detail.value }); },
  onWeightDate(e) { this.setData({ weightDate: e.detail.value }); },
  saveGoal() {
    const profile = { ...this.data.profile };
    ['age', 'height', 'startWeight', 'targetWeight', 'dailyTarget'].forEach(field => { profile[field] = profile[field] === '' || profile[field] == null ? null : Number(profile[field]); });
    if (!Number.isFinite(profile.dailyTarget) || profile.dailyTarget < 1200 || profile.dailyTarget > 5000) return this.setData({ error: '每日目标请设置在 1200–5000 kcal；特殊营养需求请咨询专业人士。' });
    if (profile.age != null && (!Number.isInteger(profile.age) || profile.age < 18 || profile.age > 100)) return this.setData({ error: '年龄请填写 18–100 的整数；当前 Demo 面向成年人。' });
    if (profile.height != null && (!Number.isFinite(profile.height) || profile.height < 120 || profile.height > 230)) return this.setData({ error: '身高请填写 120–230 cm。' });
    if (['startWeight', 'targetWeight'].some(field => profile[field] != null && (!Number.isFinite(profile[field]) || profile[field] < 30 || profile[field] > 300))) return this.setData({ error: '体重请填写 30–300 kg。' });
    if (profile.targetWeight && profile.height && profile.targetWeight / Math.pow(profile.height / 100, 2) < 18.5) return this.setData({ error: '该目标低于成人 BMI 18.5，请重新确认合理目标。' });
    try {
      wx.setStorageSync(store.storageKeys.profile, profile);
      this.setData({ error: '' });
      this.refresh();
      wx.showToast({ title: '目标已保存到本机', icon: 'success' });
    } catch (_) { this.setData({ error: '本机保存失败，请释放空间后重试。' }); }
  },
  saveWeight() {
    const value = Number(this.data.weightValue);
    if (!this.data.weightValue || !Number.isFinite(value) || value < 30 || value > 300 || this.data.weightDate > store.today()) return this.setData({ error: '请填写 30–300 kg 体重，并选择今天或过去日期。' });
    const weights = store.getWeights().filter(item => item.date !== this.data.weightDate);
    weights.push({ id: store.uid(), date: this.data.weightDate, value: store.round(value) });
    try { wx.setStorageSync(store.storageKeys.weights, weights); this.setData({ weightValue: '', error: '' }); this.refresh(); wx.showToast({ title: '体重已保存', icon: 'success' }); }
    catch (_) { this.setData({ error: '本机保存失败，请释放空间后重试。' }); }
  },
  removeWeight(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '删除这次体重？', content: '仅删除这条本机测量记录。', success: result => {
      if (!result.confirm) return;
      try { wx.setStorageSync(store.storageKeys.weights, store.getWeights().filter(item => item.id !== id)); this.refresh(); }
      catch (_) { this.setData({ error: '本机保存失败。' }); }
    } });
  },
  drawChart() {
    const weights = this.data.chartWeights;
    if (!weights.length) return;
    wx.createSelectorQuery().select('#weight-trend').boundingClientRect(rect => {
      if (!rect) return;
      const context = wx.createCanvasContext('weight-trend', this);
      const width = rect.width;
      const height = rect.height;
      const values = weights.map(item => item.value);
      const minimum = Math.min(...values) - 0.3;
      const maximum = Math.max(...values) + 0.3;
      const x = index => weights.length > 1 ? 20 + index * (width - 40) / (weights.length - 1) : width / 2;
      const y = value => height - 20 - (value - minimum) * (height - 40) / (maximum - minimum);
      context.setStrokeStyle('#e4eaf3'); context.setLineWidth(1);
      [0.25, 0.5, 0.75].forEach(ratio => { context.beginPath(); context.moveTo(14, height * ratio); context.lineTo(width - 14, height * ratio); context.stroke(); });
      context.setStrokeStyle('#1f83ff'); context.setLineWidth(2.5); context.beginPath();
      weights.forEach((item, index) => { if (index) context.lineTo(x(index), y(item.value)); else context.moveTo(x(index), y(item.value)); }); context.stroke();
      context.setFillStyle('#1f83ff'); weights.forEach((item, index) => { context.beginPath(); context.arc(x(index), y(item.value), 3.5, 0, 2 * Math.PI); context.fill(); });
      context.draw();
    }).exec();
  }
});
