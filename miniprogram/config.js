module.exports = {
  // WeChat Mini Program requests must use an HTTPS domain whitelisted in the
  // WeChat console. Change this value for staging or a local tunnel.
  apiBaseUrl: 'https://www.leanwise.lydiaowo.com',
  appId: 'wx5971d92eb86b0234',
  // Keep false until the server implements login-code exchange and a user
  // identity/session endpoint. Never put AppSecret in this project.
  enableWechatLogin: false,
  storageKeys: {
    records: 'leanwise_records',
    profile: 'leanwise_profile',
    products: 'leanwise_products',
    recipes: 'leanwise_recipes',
    weights: 'leanwise_weights',
    health: 'leanwise_health',
    preferences: 'leanwise_preferences',
    completedDates: 'leanwise_completed_dates',
    aiConsent: 'leanwise_ai_consent'
  }
};
