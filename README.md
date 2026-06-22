# 提水長大賽 💧🌱

手機優先的三隊點擊接力遊戲。隊員人數不限，所有人從取水起點輪流接力，把水提到終點讓五位小人長大；最先讓五位小人全部長大的隊伍獲勝。畫面以 emoji 卡通角色呈現，桌面與手機皆可流暢遊玩。

## 立即遊玩

- **[開啟遊戲主控台](https://jesuswaytaipeisrv.github.io/water-relay-game/?view=host)**

主持人開啟連結後會自動產生六碼房間，網址與 QR Code 都會帶入該房間碼。玩家應掃描主持台 QR Code 加入；正式多人活動須確認頁面頂端顯示「即時多人模式」。

## 玩法

1. 玩家只輸入名字加入等待名單，由主持人按「自動分隊」依加入順序平均分配到晨露隊、河浪隊與嫩芽隊。
2. 玩家用大面積按鈕快速連點打水，每次點擊增加隊伍一單位水量。
3. 提滿主持人設定的打水次數即完成一桶水，會派一位隊員（🏃🪣）從左側取水起點跑到右側終點灌溉（💦），再折返；下一位接力出發。
4. 終點五位小人（🧒）依累積澆水比例平滑長大，達標後變成大人（🧑✨）。
5. 最先讓五位小人全部長大的隊伍獲勝（🏆）。

## 介面

- **主持頁**：左側控制面板（分隊、設定、QR Code、玩家名單），右側三隊同場賽場；每隊一條橫向賽道（左取水、右灌溉），手機上自動垂直堆疊、不需橫向捲動。
- **玩家頁**：加入後只保留所屬隊伍、打水次數、隊伍成長進度條與大型打水按鈕；按鈕會依所屬隊伍顏色點亮。

## 技術

- 純 HTML / CSS / ES Module JavaScript，無建置步驟，適合 GitHub Pages 或 Zeabur 靜態網站。
- 角色全部以 emoji 呈現，無圖片資產、跨裝置渲染一致。
- Firebase Realtime Database + 匿名登入提供跨手機即時同步；未設定或連線失敗時退回 `localStorage` + `BroadcastChannel` 的同瀏覽器示範模式。
- 以隊伍累積 `waterUnits` 作為唯一計分來源，避免多人同時點擊重複計分。
- 目前快取版本：`styles.css?v=20260622-5`、`app.js?v=20260622-5`。

## 文件

- [使用說明](USER_GUIDE.md)
- [開發紀錄](DEVELOPMENT_LOG.md)
- [Firebase 設定範例](firebase-config.example.js)

## 快速開始（本機）

```sh
cd ~/Documents/Claude/Projects/water-relay-game
python3 -m http.server 5175 --bind 127.0.0.1
```

開啟主持台：`http://127.0.0.1:5175/?view=host`。主持頁會自動改成帶有房間碼的網址；同一台裝置示範時，可把該網址的 `room` 複製到 `?view=play&room=房間碼`。正式多人活動請先依[使用說明](USER_GUIDE.md)設定 Firebase，並使用公開 HTTPS 網址。

## 專案結構

- `index.html`：遊戲畫面與可及性標記
- `styles.css`：手機優先的視覺與動畫
- `app.js`：狀態同步、點擊、倒水計算與主持控制
- `firebase-config.js`：Firebase Web 公開設定，供前端連線使用
- `firebase-database.rules.json`：Realtime Database 規則範本

## 成本與安全

- 前端與 GitHub Pages 可免費使用；Firebase Realtime Database 有免費額度，超量或升級 Blaze 方案才可能產生費用。活動前請至 Firebase Console 查看方案與用量。
- Firebase Web 設定不是私密金鑰；不要提交服務帳戶 JSON、`.env` 或任何後端金鑰。
- 規則範本適合短期現場活動，不是嚴格的帳號權限模型。公開活動應使用較難猜測的房間碼，並在活動後於 Firebase Console 清除該房間資料。
