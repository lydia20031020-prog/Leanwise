const config = require('./config');
App({
  globalData: { config },
  onLaunch() {
    wx.onNeedPrivacyAuthorization(resolve => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.showPrivacyPrompt === 'function') page.showPrivacyPrompt(resolve);
      else resolve({ event: 'disagree' });
    });
    ['records', 'products', 'recipes', 'weights', 'health', 'completedDates'].forEach(name => {
      const key = config.storageKeys[name];
      if (!Array.isArray(wx.getStorageSync(key))) wx.setStorageSync(key, []);
    });
    // Login is intentionally disabled until a server-side code exchange exists.
    if (config.enableWechatLogin) console.warn('enableWechatLogin requires a server-side wx.login code exchange.');
  }
});
