// The application routes wx.onNeedPrivacyAuthorization to the visible page.
// Resolve only after a real agreePrivacyAuthorization button event.
module.exports = {
  showPrivacyPrompt(resolve) {
    this.privacyResolvers = this.privacyResolvers || [];
    this.privacyResolvers.push(resolve);
    this.setData({ showPrivacy: true, privacyError: '' });
    wx.getPrivacySetting({ success: result => this.setData({ privacyContractName: result.privacyContractName || '小程序用户隐私保护指引' }), fail() {} });
  },
  openPrivacyContract() {
    wx.openPrivacyContract({ fail: () => this.setData({ privacyError: '微信后台尚未配置隐私指引，请联系管理员。' }) });
  },
  agreePrivacy() {
    (this.privacyResolvers || []).forEach(resolve => resolve({ buttonId: 'leanwise-privacy-agree', event: 'agree' }));
    this.privacyResolvers = [];
    this.setData({ showPrivacy: false });
  },
  disagreePrivacy() {
    (this.privacyResolvers || []).forEach(resolve => resolve({ event: 'disagree' }));
    this.privacyResolvers = [];
    this.setData({ showPrivacy: false });
  },
  onUnload() { (this.privacyResolvers || []).forEach(resolve => resolve({ event: 'disagree' })); this.privacyResolvers = []; }
};
