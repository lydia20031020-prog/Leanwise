const { askAdvisor } = require('../../utils/api');
const store = require('../../utils/storage');
Page({
  data: { question: '', answer: '', error: '', busy: false, summary: '' },
  onShow() {
    const context = store.advisorContext();
    this.setData({ summary: '截至目前已记录 ' + context.today.totals.kcal + ' kcal；每日目标 ' + context.target.dailyKcal + ' kcal；体重记录 ' + context.weights.length + ' 次。' });
  },
  onQuestion(e) { this.setData({ question: e.detail.value }); },
  async ask() {
    if (this.data.busy) return;
    if (!this.data.question.trim()) return this.setData({ error: '请输入一个问题。' });
    if (!(await store.ensureAiConsent())) return;
    this.setData({ busy: true, error: '' });
    try {
      const result = await askAdvisor(this.data.question.trim(), store.advisorContext());
      this.setData({ answer: result.answer || '顾问暂时没有返回建议。' });
    } catch (e) { this.setData({ error: e.message || '顾问请求失败' }); }
    finally { this.setData({ busy: false }); }
  }
});
