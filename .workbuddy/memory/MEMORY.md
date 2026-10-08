# 项目长期记忆：会有时计数器（微信小程序）

## 技术栈与历史变更
- 中考体育 AI 视觉计数（跳绳/垫球）。当前主链路走 **VisionKit 端侧关键点**，无后端、全本地存储。
- 2026-07-27 原 AI 子包（MoveNet/tfjs）整包移除；`workers/skipPose.js`、`package.json` 的 `@mediapipe/tasks-vision`、`utils/sensors.js` 均为遗留/参考代码，当前未引用。
- `project.config.json` 已移除 `packNpmManually` 与 `packNpmRelationList`；`package.json` 依赖为空（无需 npm install / 构建 npm）。

## 可复用约束
- **微信分享（截图 + 原生图片菜单方案）**：训练结果页 `pages/index` 与数据页 `pages/data` 的分享主路径都用 `wx.showShareImageMenu({path, needShowEntrance:true, entrancePath:'pages/home/home'})`——生成 Canvas 成绩卡片后弹起微信原生「分享图片」菜单（自带 发送给朋友 / 分享到朋友圈 / 收藏 / 保存图片 / 转发为贴图），`needShowEntrance` 会在图上嵌入小程序入口码，好友/朋友圈点入口即进小程序。两个页面统一函数名为 `shareByImage()`，触发前若卡片未生成会先 `_drawShareCard()` 再延时检测 `this._shareCardPath`。`onShareAppMessage`/`onShareTimeline`（右上角 `···` 菜单）保留作为辅助卡片分享，返回 `path:'/pages/home/home'`。
- `app.json` 的 `permission` 字段仅支持 `scope.userLocation` 等定位类 scope，**camera 不需要也不能在此声明**；相机走 `<camera>` 组件，隐私合规走 `__usePrivacyCheck__` + 隐私协议页。

## 页面与分享落点
- 分享卡片（Canvas 绘制）在 pages/index 与 pages/data 各自实现；`onShareAppMessage` 的 `path` 统一为 `/pages/home/home`。
- `pages/index` 的 `onLoad(options)` 对 sport/mode/duration 等参数均有兜底默认值，从朋友圈打开不会崩。

## 分组训练架构（重要约定）
- 分组是**叠加在模式之上的开关**（`isGroup`），不再是第 4 种 mode。首页 `home.js` 用 `groupOn` 开关，开启后参数随模式变化：定时=每组时长+休息、定数=每组个数+休息、自由=仅休息。`start()` 在 `groupOn` 时追加 `&group=1&sets&work&rest`；`work` 含义随模式（定时=秒 / 定数=个）。
- 训练页 `index.js` 解析 `group` 参数→`isGroup`，`mode` 白名单收敛为 timed/counted/free。**每组结束条件随模式**：timed=计时到 `groupWork` 秒；counted=达到 `groupWork` 个（用 `_setStartCount` 记本组起点、组内个数=总数−起点）；free=用户手动点「结束本组」(`_groupEndWork`)。三种共用 `_onGroupPhaseEnd` 收尾（末组直接结算、否则进休息），计时仍按墙钟 `_phaseEndTs` 推导（定数/自由工作组 `_phaseEndTs=0` 不靠时间）。
- WXML 里**所有原 `mode === 'group'` 判断已改为 `isGroup`**（HUD 中段 pill、结果页「完成组数/净训练用时」）。定数分组中段 pill 显示 `groupSetCount/groupSetTarget`；自由分组工作段显示「结束本组」按钮（`bindtap="groupEndWork"`）。
- 删除的旧概念：`mode=group` 第 4 模式、`home.js` 的 `goGroup/closeGroup/groupStart` 独立入口与底部 `group-overlay` 抽屉（已改为首页内联开关+步进行）。
