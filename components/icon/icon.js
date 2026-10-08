// components/icon/icon.js
const { buildSvg, BRAND } = require('./icons.js');

Component({
  properties: {
    // 图标名称（见 icons.js 的 ICONS 键）
    name: { type: String, value: '' },
    // 尺寸（rpx）
    size: { type: Number, value: 48 },
    // 描边颜色，缺省品牌红
    color: { type: String, value: BRAND },
  },

  data: {
    src: '',
  },

  lifetimes: {
    attached() {
      this._render();
    },
  },

  observers: {
    'name,size,color': function () {
      this._render();
    },
  },

  methods: {
    _render() {
      const { name, color } = this.data;
      this.setData({ src: buildSvg(name, color) });
    },
  },
});
