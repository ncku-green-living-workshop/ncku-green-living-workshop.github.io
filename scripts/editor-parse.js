'use strict';
/**
 * index.html 的文案解析與寫回。
 *
 * 核心原則：只記錄位置索引，永不重建 DOM。寫回時用字串切片，由後往前套用，
 * 所以沒被編輯到的部分保證 byte-identical——縮排、註解、屬性順序全部原封不動。
 *
 * 直接執行本檔會跑自檢：node scripts/editor-parse.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

// 自閉合元素，掃描時不計入深度
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source',
  'area', 'col', 'embed', 'track', 'wbr']);

/**
 * 從開標籤的 '>' 位置往後找到真正配對的結束標籤。
 * 用同名標籤深度計數——12 個節點內含巢狀同名 <span>，單純找第一個 </span> 會截斷內容。
 * 回傳 { innerStart, innerEnd, end }。
 */
function findClose(src, tagName, gtIndex) {
  const re = new RegExp(`</?${tagName}(?=[\\s/>])`, 'gi');
  re.lastIndex = gtIndex + 1;
  let depth = 1;
  for (let m; (m = re.exec(src)); ) {
    const isClose = src[m.index + 1] === '/';
    const gt = src.indexOf('>', m.index);
    if (gt === -1) break;
    if (isClose) {
      if (--depth === 0) return { innerStart: gtIndex + 1, innerEnd: m.index, end: gt + 1 };
    } else if (src[gt - 1] !== '/') {
      depth++;
    }
    re.lastIndex = gt + 1;
  }
  throw new Error(`unbalanced <${tagName}> starting at ${gtIndex}`);
}

// 屬性字串裡可能有 > 夾在引號中，所以逐字元容忍引號而非貪吃到第一個 >
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*?`;

function scan(src, re, handler) {
  const out = [];
  for (let m; (m = re.exec(src)); ) {
    const r = handler(m);
    if (r) out.push(r);
  }
  return out;
}

/** 各 section 的起始位置，用來判斷某個節點屬於哪一段。 */
function sectionMap(src) {
  return scan(src, /<span class="lbl en">([^<]+)<\/span>/g,
    m => ({ at: m.index, name: m[1].trim() }));
}

function sectionAt(sections, pos) {
  let name = 'HEADER';
  for (const s of sections) {
    if (s.at > pos) break;
    name = s.name;
  }
  return name;
}

/** 1. 85 組 zh/en 散文 */
function parseProse(src, bodyStart, sections) {
  const re = new RegExp(`<(\\w+)(${ATTRS}\\bdata-l="(zh|en)"${ATTRS})>`, 'g');
  re.lastIndex = bodyStart;
  const nodes = [];
  for (let m; (m = re.exec(src)); ) {
    const { innerStart, innerEnd, end } = findClose(src, m[1], m.index + m[0].length - 1);
    nodes.push({
      tag: m[1], lang: m[3], start: m.index, innerStart, innerEnd, end,
      html: src.slice(innerStart, innerEnd),
    });
    re.lastIndex = end;
  }

  // 嚴格 ZE 交替是本工具的核心前提，破了就得停下來而不是猜。
  const seq = nodes.map(n => (n.lang === 'zh' ? 'Z' : 'E')).join('');
  if (!/^(ZE)+$/.test(seq)) {
    throw new Error('data-l 節點不再是嚴格 zh/en 交替，解析器需要修改後才能安全寫回');
  }

  const items = [];
  for (let i = 0; i < nodes.length; i += 2) {
    const zh = nodes[i], en = nodes[i + 1];
    items.push({
      id: `prose-${i / 2}`,
      section: sectionAt(sections, zh.start),
      zh: zh.html,
      en: en.html,
      hasMarkup: /<\w/.test(zh.html) || /<\w/.test(en.html),
      zhSpan: [zh.innerStart, zh.innerEnd],
      enSpan: [en.innerStart, en.innerEnd],
    });
  }
  return items;
}

// Inverse of the escaping editor.js applies when writing META back.
const unescapeJs = s => s.replace(/\\(x3C|n|'|\\)/g, (_, c) =>
  c === 'x3C' ? '<' : c === 'n' ? '\n' : c);

/** 2. META 物件的 4 個字串（title/desc × zh/en） */
function parseMeta(src) {
  const items = [];
  // 逐一定位 zh:{...} 與 en:{...} 區塊內的 title/desc 字串值
  for (const lang of ['zh', 'en']) {
    const block = new RegExp(`\\b${lang}:\\s*\\{`, 'g');
    const bm = block.exec(src);
    if (!bm) continue;
    const scopeEnd = src.indexOf('}', bm.index);
    for (const key of ['title', 'desc']) {
      const kre = new RegExp(`\\b${key}\\s*:\\s*'`, 'g');
      kre.lastIndex = bm.index;
      const km = kre.exec(src);
      if (!km || km.index > scopeEnd) continue;
      const vs = km.index + km[0].length;
      let ve = vs;
      while (ve < src.length && !(src[ve] === "'" && src[ve - 1] !== '\\')) ve++;
      items.push({
        id: `meta-${lang}-${key}`, lang, key,
        section: 'META',
        text: unescapeJs(src.slice(vs, ve)),
        span: [vs, ve],
      });
    }
  }
  return items;
}

/**
 * 3. 14 組一次性圖片 alt（英文在 data-alt-en=）。
 * 有兩種形狀：
 *   a) <img alt="中文" data-alt-en="English">          —— 7 筆，中英同標籤
 *   b) <div class="shots" data-alt-en="English"><img alt="中文" …>
 *      —— 6 筆，英文在容器上、由 runtime 分發給底下每張圖；中文則各圖分別寫。
 *      這種取「第一張圖的 alt」當代表值編輯，其餘圖的 alt 不動。
 */
function parseAlts(src, sections) {
  const re = new RegExp(`<(\\w+)(${ATTRS}\\bdata-alt-en=${ATTRS})>`, 'g');
  return scan(src, re, m => {
    const base = m.index;
    const tag = m[0];
    const en = /\bdata-alt-en="([^"]*)"/.exec(tag);
    if (!en) return null;
    const enAt = base + en.index + en[0].indexOf('"') + 1;

    let zh = /\balt="([^"]*)"/.exec(tag);
    let zhAt;
    if (zh) {
      zhAt = base + zh.index + zh[0].indexOf('"') + 1;
    } else {
      // 容器型：往內找第一個 <img> 的 alt
      const { innerStart, innerEnd } = findClose(src, m[1], base + tag.length - 1);
      const inner = src.slice(innerStart, innerEnd);
      const im = /<img[^>]*?\balt="([^"]*)"/.exec(inner);
      if (!im) return null;
      zh = [, im[1]];
      // im[0] 以 alt="…" 結尾，值的起點 = 該片段長度扣掉值與收尾引號
      zhAt = innerStart + im.index + im[0].length - im[1].length - 1;
    }

    return {
      id: `alt-${base}`,
      section: sectionAt(sections, base),
      zh: zh[1],
      en: en[1],
      // span 指向屬性「值」本身，不含引號
      zhSpan: [zhAt, zhAt + zh[1].length],
      enSpan: [enAt, enAt + en[1].length],
    };
  });
}

/**
 * 4. 單語英文專名欄位。
 * 這些欄位只有一種語言，中英共用，所以單欄編輯。
 * 只取直接文字內容（到第一個子標籤為止），避免把 .sub/.faff 這類已配對的子節點吃進來。
 */
const MONO_CLASSES = ['topic', 'ftitle', 'fwho', 'mvcb', 'who'];

function parseMono(src, bodyStart, sections) {
  const items = [];
  for (const cls of MONO_CLASSES) {
    const re = new RegExp(`<(\\w+) class="${cls}">`, 'g');
    re.lastIndex = bodyStart;
    for (let m; (m = re.exec(src)); ) {
      const { innerStart, innerEnd, end } = findClose(src, m[1], m.index + m[0].length - 1);
      const inner = src.slice(innerStart, innerEnd);
      // 只編輯開頭那段純文字；後面若接子元素就留著不動
      const cut = inner.search(/<\w/);
      const textEnd = cut === -1 ? innerEnd : innerStart + cut;
      const text = src.slice(innerStart, textEnd);
      if (text.trim()) {
        items.push({
          id: `mono-${m.index}`,
          section: sectionAt(sections, m.index),
          cls,
          text,
          span: [innerStart, textEnd],
        });
      }
      re.lastIndex = end;
    }
  }
  return items.sort((a, b) => a.span[0] - b.span[0]);
}

function parse(src) {
  const bodyStart = src.indexOf('</style>');
  if (bodyStart === -1) throw new Error('找不到 </style>，index.html 結構與預期不符');
  const sections = sectionMap(src);
  return {
    prose: parseProse(src, bodyStart, sections),
    meta: parseMeta(src),
    alts: parseAlts(src, sections),
    mono: parseMono(src, bodyStart, sections),
  };
}

/**
 * 套用編輯。edits 是 [{span:[start,end], value}]，由後往前寫入避免位移。
 * 呼叫端負責保證 span 不重疊。
 */
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => b.span[0] - a.span[0]);
  let out = src;
  let prevStart = Infinity;
  for (const e of sorted) {
    if (e.span[1] > prevStart) throw new Error('編輯範圍重疊，中止寫回');
    out = out.slice(0, e.span[0]) + e.value + out.slice(e.span[1]);
    prevStart = e.span[0];
  }
  return out;
}

const readIndex = () => fs.readFileSync(INDEX, 'utf8');
const writeIndex = s => fs.writeFileSync(INDEX, s);

module.exports = { parse, applyEdits, readIndex, writeIndex, INDEX, ROOT, MONO_CLASSES };

// ---------------------------------------------------------------------------
// 自檢：node scripts/editor-parse.js
// 這幾條正是實際會出錯的地方，尤其是巢狀同名 span 的截斷問題。
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const src = readIndex();
  const c = parse(src);
  let n = 0;
  const ok = (label, fn) => { fn(); console.log(`  ✓ ${label}`); n++; };

  console.log('editor-parse 自檢\n');

  ok('解析出 85 組 zh/en 散文', () => assert.strictEqual(c.prose.length, 85));

  ok('序列嚴格 zh/en 交替（parse 內建檢查未拋錯）', () => {
    assert.ok(c.prose.every(p => typeof p.zh === 'string' && typeof p.en === 'string'));
  });

  ok('未修改時寫回與原檔 byte-identical', () => {
    const edits = c.prose.flatMap(p => [
      { span: p.zhSpan, value: p.zh }, { span: p.enSpan, value: p.en },
    ]);
    assert.strictEqual(applyEdits(src, edits), src);
  });

  ok('含巢狀同名 span 的節點內容完整未被截斷', () => {
    const nested = c.prose.filter(p => /<span/.test(p.zh));
    assert.ok(nested.length >= 6, `預期至少 6 筆含巢狀 span，實得 ${nested.length}`);
    for (const p of nested) {
      const opens = (p.zh.match(/<span[\s>]/g) || []).length;
      const closes = (p.zh.match(/<\/span>/g) || []).length;
      assert.strictEqual(opens, closes, `span 不平衡：${p.zh.slice(0, 60)}`);
    }
  });

  ok('街廓範圍那 4 筆 .desc 的中文完整（結尾不是被截斷的 span）', () => {
    const rows = c.prose.filter(p => p.zh.includes('class="zh"'));
    assert.strictEqual(rows.length, 4, `預期 4 筆街廓列，實得 ${rows.length}`);
    for (const r of rows) assert.ok(/<\/span>/.test(r.zh) && r.zh.trim().length > 20);
  });

  ok('改一筆中文後只有該處變動', () => {
    const t = c.prose.find(p => !p.hasMarkup);
    const mod = applyEdits(src, [{ span: t.zhSpan, value: t.zh + '測試' }]);
    assert.strictEqual(mod.length, src.length + 2);
    // 確認差異只有一段連續區塊
    let i = 0; while (src[i] === mod[i]) i++;
    let j = 0; while (src[src.length - 1 - j] === mod[mod.length - 1 - j]) j++;
    assert.ok(i + j >= src.length - 20, '差異超出單一節點範圍');
  });

  ok('META 抓到 4 個字串', () => {
    assert.strictEqual(c.meta.length, 4);
    assert.ok(c.meta.find(m => m.lang === 'zh' && m.key === 'title').text.includes('綠色生活'));
  });

  ok('圖片 alt 抓到 14 組', () => assert.strictEqual(c.alts.length, 14));

  ok('alt 的 span 精準指向屬性值', () => {
    for (const a of c.alts) {
      assert.strictEqual(src.slice(a.zhSpan[0], a.zhSpan[1]), a.zh);
      assert.strictEqual(src.slice(a.enSpan[0], a.enSpan[1]), a.en);
      assert.strictEqual(src[a.zhSpan[1]], '"');
    }
  });

  ok('單語英文欄位抓到且不含子標籤', () => {
    assert.ok(c.mono.length >= 30, `mono 只抓到 ${c.mono.length} 筆`);
    for (const m of c.mono) assert.ok(!/<\w/.test(m.text), `mono 混入子標籤：${m.text}`);
    assert.ok(c.mono.some(m => m.cls === 'topic'));
    assert.ok(c.mono.some(m => m.cls === 'ftitle'));
  });

  ok('全部欄位 span 互不重疊', () => {
    const spans = [
      ...c.prose.flatMap(p => [p.zhSpan, p.enSpan]),
      ...c.meta.map(m => m.span),
      ...c.alts.flatMap(a => [a.zhSpan, a.enSpan]),
      ...c.mono.map(m => m.span),
    ].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      assert.ok(spans[i][0] >= spans[i - 1][1],
        `span 重疊：${JSON.stringify(spans[i - 1])} / ${JSON.stringify(spans[i])}`);
    }
  });

  console.log(`\n${n} 項全過。散文 ${c.prose.length} 組、META ${c.meta.length}、` +
    `alt ${c.alts.length} 組、單語欄位 ${c.mono.length} 筆。`);
}
