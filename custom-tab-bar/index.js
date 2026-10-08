// custom-tab-bar/index.js
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/home/home', text: '运动', icon: 'activity' },
      { pagePath: '/pages/data/data', text: '数据', icon: 'bar-chart' },
      { pagePath: '/pages/challenge/challenge', text: '挑战', icon: 'flag' },
      { pagePath: '/pages/achievement/achievement', text: '成就', icon: 'trophy' },
      { pagePath: '/pages/profile/profile', text: '我的', icon: 'user' },
    ],
  },
  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset;
      const item = this.data.list[index];
      wx.switchTab({ url: item.pagePath });
    },
  },
});
