# green-living-workshop

「超高齡社會下的綠色生活」國際工作坊（2026/8/1–8/7）的成果介紹網站。

**線上版本**：https://ncku-green-living-workshop.github.io/

老師於 2026-08-18 交辦，起因是 K-Bus（音譯）希望把工作坊成果與過程放上網路，讓各參與國的老師能帶回自己的學校介紹與交流。

## 現況

已完成並上線。內容包含：

| 區塊 | 內容 |
|---|---|
| 課程流程 | D1–D6，每日 4 張照片 + 課程名 + 講者（取自官方英文課表） |
| 工作坊現場 | 60 張照片三欄瀑布 |
| 各組成果 | 7 組，可展開影片（2–3 分鐘）+ 簡報翻頁器（共 237 頁） |
| 國際論壇 | 8/7 完整議程 10 項 + 講者照片 + 合照 |
| 語言 | 中／英雙語，右上角切換 |

## 技術

單一 `index.html`（約 130KB），CSS/JS 全部內嵌。**無建置流程、無 npm、無 CDN 依賴**（僅 Google Fonts）。
託管在 GitHub Pages，改檔 `git push` 後約 60 秒自動上線。

### 中英切換

中英文都寫在同一份 `index.html` 裡，右上角按鈕只改 `<html lang>` 一個屬性，兩條 CSS 規則就把另一種語言藏起來：

```css
html[lang^="zh"] [data-l="en"]{display:none !important}
html[lang="en"]  [data-l="zh"]{display:none !important}
```

- **要改文案**：搜尋該段中文，旁邊就是成對的 `data-l="en"` 版本，直接改 HTML。
- **`data-l` 的意思是「在這個模式顯示」，不是「這段文字是這種語言」**。ABOUT 段的英文摘要標的是 `data-l="zh"`，因為它只屬於中文版面（大段中文＋小字英文摘要）；英文模式改用完整英譯。不要把它「改正」成 `en`。
- **`.en` 和 `.sub` 是排版類別，不是語言標記**（`.sub` 裡也有中文，`.en` 也用在時間戳）。絕不能拿來當切換依據。
- **`alt` / `aria-label` 走 JS**，因為 CSS 動不了屬性。237 個縮圖標籤由樣板產生，不是手寫的。
- **分享英文版**：網址加 `?lang=en`，可以和 `#g5-deck` 這種深連結並存。使用者的選擇會記在 localStorage。
- **社群預覽卡永遠是中文**：平台抓的是伺服器送出的原始 HTML，不是 JS 改過的 DOM。單一檔案方案無法解決這點。

## 檔案

| 路徑 | 內容 |
|---|---|
| `index.html` | 網站本體 |
| `design-tokens.md` | 視覺規則的單一真實來源。**改樣式前先讀這份** |
| `SPEC.md` | 內容與形式規格書，含老師口頭指示的出處時間戳 |
| `scripts/optimize-photos.sh` | 照片批次壓縮 |
| `scripts/build-media.sh` | 影片壓縮 + 簡報 PDF 轉圖 |
| `assets/photos/` | 96 張壓縮後照片（每日 16 張） |
| `assets/slides/gN/` | 各組簡報逐頁 JPEG |
| `assets/video/` | 7 支壓縮後影片 + poster |
| `assets/forum/` | 論壇講者與合照 |

## ⚠️ 原始素材沒有進版控

`assets/raw/`（4.8GB）、`assets/videos/`（932MB）、`assets/pdf/`（264MB）合計約 **6GB**，
在 `.gitignore` 中排除，**只存在本機**。

**這些檔案遺失就無法重新產生網站素材** —— Drive 上雖有備份，但那是他人帳號、非本人擁有。
**請另外備份到外接硬碟或自己的雲端。**

## 重建素材的方式

```bash
# 照片：assets/raw/D1..D7/ → assets/photos/
MAX_PER_DAY=16 ./scripts/optimize-photos.sh

# 影片與簡報：assets/videos/ 與 ~/Downloads/Group N.pdf → assets/video/, assets/slides/
./scripts/build-media.sh
```

兩支腳本都會跳過已存在的輸出，可重複執行。需要 `ffmpeg` 與 `pdftoppm`（`brew install ffmpeg poppler`）。

> ⚠️ **`assets/photos/` 內有人工指定來源的照片**（如 `d3-01`、`d3-02`、`d3-04`、`d6-02`、`d6-03`、`d6-04`），
> 它們的來源檔名與 `assets/raw/` 的排序序號無關。`optimize-photos.sh` 是依序號輸出的，
> 因此**不可用 `FORCE=1` 全量重跑**，否則這些照片會被排序第 N 張覆蓋掉。
> 要重新產生單一張，請先手動刪除該檔再執行。

## 編輯文案

不用手改 `index.html`，跑編輯器：

```bash
node scripts/editor.js        # → http://127.0.0.1:4321
```

零依賴，只用 Node 內建模組。介面依區塊分頁，左欄編輯中文、右欄英文唯讀。
涵蓋四類文字：78 組 `data-l` 散文、`META` 標題與描述、13 組圖片 `alt`、
以及只有一種語言的專名欄位（`.topic` / `.ftitle` / `.fwho` / `.mvcb` / `.who`）。

流程是**中文 → 存檔 → 翻譯 → Push**：

1. 改中文按存檔。變動的段落會寫進 `.editor-pending.json`（不進版控）。
2. 在 Claude Code 說「翻譯待翻項目」。翻譯必須遵守 `scripts/glossary.json`——
   那裡鎖著查官方來源校對過的譯名（路名漢語拼音、里=Village、
   仲觀＝J.M. Lin Architect / The Observer Design Group 等），**不得憑語感改寫**。
3. 按 Push，介面會先跑結構自檢並顯示 `git diff --stat` 等你確認，才 commit + push。

還有待翻項目時 Push 會出示提醒但不擋——你可以只推中文先上線。

寫回採位置索引切片，沒編輯到的部分保證 byte-identical，縮排與註解不會被重排。
改動解析器後跑自檢：

```bash
node scripts/editor-parse.js
```

> ⚠️ `data-l` 的語意是「在這個模式顯示」，不是「這段文字是這種語言」。
> 有些 `data-l="zh"` 節點裡放的是英文（見 `index.html` 開頭註解），不要「修正」它。

## 部署

平常改文案走上面的編輯器。手動部署：

```bash
git add -A && git commit -m "..." && git push
```

GitHub Pages 自動建置。查狀態：`gh api repos/ncku-green-living-workshop/ncku-green-living-workshop.github.io/pages --jq '.status'`

## 已知落差

- **MVCB 分群資料**未取得（各組成果目前顯示基地代碼與指導老師）
- 論壇 12 支講者錄影（每支約 1GB）未放上網站，僅用照片呈現
- 網站設 `noindex`：可用連結瀏覽，但不被搜尋引擎收錄

## 相關

- 需求來源：vault `30-筆記/會議紀錄/2026-08-18_碩論方向與工作坊檢討會議.md`
- 視覺參考：`~/Desktop/claude-code/group-report-launcher/index.html`

> 專案即時狀態不寫在這裡 —— 唯一來源是 vault 的 `20-資料夾概述/索引/專案索引.md`。
