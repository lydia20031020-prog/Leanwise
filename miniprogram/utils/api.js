const config = require('../config');

function request(path, data, method = 'POST') {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method,
      data,
      timeout: 70000,
      header: { 'content-type': 'application/json' },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        const body = res.data || {};
        reject(new Error(body.error || `请求失败（${res.statusCode}）`));
      },
      fail(error) { reject(new Error(error.errMsg || '无法连接 Leanwise 服务')); }
    });
  });
}

module.exports = {
  config,
  getStatus() { return request('/api/status', {}, 'GET'); },
  demoSync(source) { return request('/api/health/demo-sync', { source }); },
  analyzeFood(text, image, memory) { return request('/api/analyze', { text: text || '', image: image || undefined, memory: memory || {} }); },
  askAdvisor(question, context) { return request('/api/advice', { question, context }); }
};
