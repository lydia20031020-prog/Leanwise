const { analyzeFood } = require('../../utils/api');
const store = require('../../utils/storage');
Page({
  ...require('../../utils/privacy'),
  data: { text: '', imagePath: '', busy: false, saved: false, error: '', note: '', draft: [], remember: true,
    rememberRecipe: false, recipeName: '', products: [], productNames: [], units: store.units, mealTypes: ['早餐', '午餐', '晚餐', '加餐'],
    mealType: '加餐', date: store.today(), maxDate: store.today(), time: store.currentTime(), editId: '', showPrivacy: false, privacyContractName: '小程序用户隐私保护指引', privacyError: '' },
  onLoad(options) {
    const products = store.getProducts();
    this.setData({ products, productNames: products.map(product => product.name) });
    if (options.recipeId) {
      const recipe = store.getRecipes().find(value => value.id === options.recipeId);
      if (recipe) this.setDraft(store.expandRecipe(recipe, products));
    }
    if (options.editId) {
      const meal = store.getRecords().find(value => value.id === options.editId);
      if (meal) {
        this.setData({ editId: meal.id, date: meal.date, time: meal.time, mealType: meal.type || '加餐', text: meal.note || '', imagePath: meal.photo || '' });
        this.existingPhoto = meal.photo || '';
        this.existingDate = meal.date;
        this.setDraft(meal.items.map(item => ({ ...item })));
      }
    }
  },
  setDraft(draft) { this.setData({ draft: draft.map(item => ({ ...item, totals: store.validItem(item) ? store.itemTotals(item) : null })) }); },
  onText(e) { this.setData({ text: e.detail.value }); },
  onDate(e) { this.setData({ date: e.detail.value }); },
  onTime(e) { this.setData({ time: e.detail.value }); },
  onMealType(e) { this.setData({ mealType: this.data.mealTypes[Number(e.detail.value)] }); },
  takePhoto() { this.chooseImage('camera'); },
  choosePhoto() { this.chooseImage('album'); },
  chooseImage(source) {
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['compressed'],
      success: result => this.setData({ imagePath: result.tempFiles[0].tempFilePath, error: '' }),
      fail: error => { if (!String(error.errMsg).includes('cancel')) this.setData({ error: '无法选择照片，请检查相机或相册权限。' }); } });
  },
  removeImage() { this.setData({ imagePath: '' }); },
  previewImage() { if (this.data.imagePath) wx.previewImage({ urls: [this.data.imagePath] }); },
  async analyze() {
    if (this.data.busy || this.data.saved) return;
    const text = this.data.text.trim();
    if (!text) return this.setData({ error: '当前模型不支持图片识别。请补充食品名称和份量，或点击“手动添加食品”。' });
    const recipe = store.getRecipes().find(value => value.name === text || (value.aliases || []).includes(text));
    if (recipe) {
      this.setDraft(store.expandRecipe(recipe, store.getProducts()));
      this.setData({ error: '', note: '已使用你的常用配方与当前食品营养数据，核对本次份量后保存。' });
      return;
    }
    if (!(await store.ensureAiConsent())) return;
    this.setData({ busy: true, error: '' });
    try {
      const result = await analyzeFood(text, undefined, { products: store.getProducts(), recipes: store.getRecipes() });
      this.setDraft(result.items.map(item => ({ ...item, id: item.id || store.uid() })));
      this.setData({ note: (this.data.imagePath ? '本次根据文字解析，照片未参与识别。' : '') + (result.note || '') });
    } catch (error) { this.setData({ error: error.message || 'AI 解析失败，可以手动记录。' }); }
    finally { this.setData({ busy: false }); }
  },
  addItem() {
    this.setDraft([...this.data.draft, { id: store.uid(), productId: null, name: '', quantity: 100, unit: 'g', baseQuantity: 100, baseUnit: 'g',
      kcal: '', protein: '', carbs: '', fat: '', source: '手动填写', confidence: '请核对' }]);
    this.setData({ error: '' });
  },
  selectProduct(e) {
    const product = this.data.products[Number(e.detail.value)];
    if (!product) return;
    this.setDraft([...this.data.draft, { ...product, id: store.uid(), productId: product.id, quantity: product.baseQuantity,
      baseUnit: product.unit, source: 'memory', confidence: 'high' }]);
  },
  removeItem(e) { this.setDraft(this.data.draft.filter((_, index) => index !== Number(e.currentTarget.dataset.index))); },
  editItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    const draft = this.data.draft.map(item => ({ ...item }));
    draft[index][field] = e.detail.value;
    if (field === 'name') draft[index].productId = null;
    this.setDraft(draft);
  },
  editUnit(e) {
    const index = Number(e.currentTarget.dataset.index);
    const unit = this.data.units[Number(e.detail.value)];
    const draft = this.data.draft.map(item => ({ ...item }));
    draft[index] = { ...draft[index], unit, baseUnit: unit, productId: null };
    this.setDraft(draft);
  },
  toggleRemember(e) { this.setData({ remember: Boolean(e.detail.value) }); },
  toggleRecipe(e) { this.setData({ rememberRecipe: Boolean(e.detail.value) }); },
  onRecipeName(e) { this.setData({ recipeName: e.detail.value }); },
  async save() {
    if (this.data.busy || this.data.saved) return;
    if (!this.data.draft.length || !this.data.draft.every(store.validItem)) return this.setData({ error: '请填写每项食品名称、正数份量/基准，以及全部营养数值（没有的填 0）。' });
    if (!this.data.date || this.data.date > store.today()) return this.setData({ error: '请选择今天或以前的日期。' });
    if (this.data.rememberRecipe && !this.data.recipeName.trim()) return this.setData({ error: '请给常用配方起名，例如“咖啡牛奶”。' });
    const oldRecipe = store.getRecipes().find(recipe => recipe.name === this.data.recipeName.trim());
    if (this.data.rememberRecipe && oldRecipe) {
      const confirmed = await new Promise(resolve => wx.showModal({ title: '更新常用配方？', content: '已存在同名配方，确认后会更新它的常用食材和份量。仅记录本次可关闭“另存为常用配方”。', success: result => resolve(result.confirm), fail: () => resolve(false) }));
      if (!confirmed) return;
    }
    this.setData({ busy: true, error: '' });
    let newPhoto = '';
    try {
      const imagePath = this.data.imagePath;
      const photo = imagePath === this.existingPhoto ? imagePath : await store.savePhoto(imagePath);
      if (photo !== this.existingPhoto) newPhoto = photo;
      let items = this.data.draft.map(({ totals, ...item }) => store.snapshotItem(item));
      const products = store.getProducts();
      let nextProducts = products;
      if (this.data.remember || this.data.rememberRecipe) {
        const result = store.rememberItems(items, products);
        nextProducts = result.products;
        items = result.items;
      }
      const meal = { id: this.data.editId || store.uid(), date: this.data.date, time: this.data.time, type: this.data.mealType,
        title: items.map(item => item.name).join(' + '), note: this.data.text.trim(), photo, items, kcal: Math.round(store.totalMeals([{ items }]).kcal), source: 'user-confirmed' };
      const previous = store.getRecords();
      const records = this.data.editId ? previous.map(item => item.id === this.data.editId ? meal : item) : [meal, ...previous];
      let recipes = store.getRecipes();
      if (this.data.rememberRecipe) {
        const recipe = { id: oldRecipe ? oldRecipe.id : store.uid(), name: this.data.recipeName.trim(), aliases: oldRecipe ? oldRecipe.aliases : [this.data.recipeName.trim()],
          items: items.map(item => ({ ...item, id: store.uid() })) };
        recipes = oldRecipe ? recipes.map(item => item.id === oldRecipe.id ? recipe : item) : [...recipes, recipe];
      }
      store.commit({ records, products: nextProducts, recipes,
        completedDates: store.getArray(store.storageKeys.completedDates).filter(date => date !== meal.date && date !== this.existingDate) });
      if (this.existingPhoto && this.existingPhoto !== photo) store.removePhoto(this.existingPhoto);
      this.setData({ saved: true });
      wx.showToast({ title: '已保存到本机', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (_) {
      if (newPhoto) store.removePhoto(newPhoto);
      this.setData({ error: '本机保存失败，可能存储空间不足。请保留当前内容，释放空间后重试。' });
    } finally { this.setData({ busy: false }); }
  }
});
