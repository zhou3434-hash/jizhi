/* ===========================================================
   寻万卷书 · 本地服务（零依赖 Node）
   -----------------------------------------------------------
   1) 静态文件服务：/  ->  index.html
   2) 书库 API 代理：/api/search  /api/book
      —— 由本机 Node 去访问 Open Library / Google Books，
         浏览器只跟 127.0.0.1 通信，因此不受跨域与直连限制影响。
      —— 自动探测本机代理（Clash/V2Ray 等），走 CONNECT 隧道出网；
         若直连可用则优先直连。
   =========================================================== */
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

/* ---------------- 配置 ---------------- */

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';

/* 豆瓣源开关（可插拔数据源）
   —— 豆瓣没有公开的书目 API，其简介/封面由页面解析获得，仅适合本地个人查询使用。
   —— 公开部署请设置 ENABLE_DOUBAN=0 关闭该源，只保留 Open Library 等开放接口。 */
const ENABLE_DOUBAN = process.env.ENABLE_DOUBAN !== '0';

const OL = 'https://openlibrary.org';
const OL_COVERS = 'https://covers.openlibrary.org';   // 封面专用域名，直接 200，不用跳转
const GB = 'https://www.googleapis.com/books/v1/volumes';
const DOUBAN = 'https://book.douban.com';
const DOUBAN_M = 'https://m.douban.com';

// 常见本地代理端口（Clash / Clash Verge / V2Ray / Mihomo / Surge ...）
const PROXY_CANDIDATES = [7897, 7890, 7891, 10809, 10808, 1080, 2080, 8889, 8080];
const CN_LANG = 'chi|zho|zh';

const HTTP_TIMEOUT = Number(process.env.API_TIMEOUT || 25000);   // 代理/直连的兜底超时
const DIRECT_TIMEOUT = Number(process.env.DIRECT_TIMEOUT || 8000); // 直连探测：快速失败，把时间让给代理
const CACHE_TTL = 10 * 60 * 1000;   // 内存缓存 10 分钟

/* ---------------- 熔断器：某主机连续失败就暂时不再请求，避免反复拖慢 ---------------- */
const BREAKER = new Map();
const BREAKER_LIMIT = 3;
const BREAKER_COOLDOWN = 90 * 1000;   // 熔断后 90 秒再试，避免长时间少一个数据源

function breakerDown(host) {
  const b = BREAKER.get(host);
  return !!(b && b.count >= BREAKER_LIMIT && Date.now() - b.at < BREAKER_COOLDOWN);
}
function breakerFail(host) {
  const b = BREAKER.get(host) || { count: 0, at: 0 };
  b.count++; b.at = Date.now();
  BREAKER.set(host, b);
}
function breakerOk(host) { BREAKER.delete(host); }

/* ---------------- 代理探测 ---------------- */

let PROXY = null;          // 形如 { host, port }
let PROXY_READY = null;    // Promise

function portOpen(host, port, ms) {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(ms || 1200);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function detectProxy() {
  const explicit = process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (await portOpen(u.hostname, Number(u.port) || 8080)) {
        return { host: u.hostname, port: Number(u.port) || 8080, from: 'env' };
      }
    } catch { /* 忽略非法值，继续探测 */ }
  }
  if (String(process.env.NO_PROXY_MODE || '') === '1') return null;
  for (const port of PROXY_CANDIDATES) {
    if (await portOpen('127.0.0.1', port, 900)) return { host: '127.0.0.1', port, from: 'scan' };
  }
  return null;
}

/* ---------------- 出网请求（直连 + 代理隧道） ---------------- */

function requestDirect(urlStr, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'XunWanJuan/1.0 (local book search)',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: DIRECT_TIMEOUT
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, buf: buf, body: buf.toString('utf8'), location: res.headers.location || '',
          contentType: String(res.headers['content-type'] || ''), headBuf: '' });
      });
    });
    if (extraHeaders && extraHeaders.Referer) req.setHeader('Referer', extraHeaders.Referer);
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

function connectTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      timeout: HTTP_TIMEOUT,
      headers: { Host: targetHost + ':' + targetPort }
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('PROXY_CONNECT_' + res.statusCode)); return; }
      socket.setTimeout(HTTP_TIMEOUT, () => socket.destroy(new Error('TIMEOUT')));
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error('PROXY_TIMEOUT')));
    req.once('error', reject);
    req.end();
  });
}

/* ---------------- 响应体解码 ----------------
   豆瓣各入口的编码声明五花八门：有的没有 Content-Type，有的声明 GBK 实为 UTF-8，
   也有真为 GBK 的页面。这里不迷信声明，先看 UTF-8 解码是否合法，非法再依次尝试中文编码。 */
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder : null;

function countBadChars(str) { return (str.match(/\uFFFD/g) || []).length; }

function decodeBody(res) {
  const buf = res.buf || Buffer.from(res.body || '', 'utf8');
  const asUtf8 = buf.toString('utf8');
  if (!textDecoder || countBadChars(asUtf8) === 0) return asUtf8;

  const decl = String(res.contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i);
  const sniff = asUtf8.slice(0, 4096).match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  const declared = String((decl && decl[1]) || (sniff && sniff[1]) || '').toLowerCase();

  const order = [];
  if (declared && declared !== 'utf-8' && declared !== 'utf8') order.push(declared === 'gbk' || declared === 'gb2312' ? 'gb18030' : declared);
  ['gb18030', 'big5', 'windows-1252'].forEach((e) => { if (order.indexOf(e) < 0) order.push(e); });

  const utf8Bad = countBadChars(asUtf8);
  for (const enc of order) {
    try {
      const out = new textDecoder(enc).decode(buf);
      if (countBadChars(out) < utf8Bad) return out;   // 坏字符更少 -> 这个解码更对
    } catch { /* 试下一个 */ }
  }
  return asUtf8;
}

/** 解码 Transfer-Encoding: chunked 的响应体 */
function dechunk(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf('\r\n', pos, 'latin1');
    if (nl < 0) break;
    const sizeLine = buf.slice(pos, nl).toString('latin1').split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!size || isNaN(size)) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    pos = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

function requestViaProxy(urlStr, proxy, extraHeaders) {
  const u = new URL(urlStr);
  const port = Number(u.port) || 443;
  if (u.protocol !== 'https:') return requestDirect(urlStr);   // 隧道只处理 https

  return connectTunnel(proxy, u.hostname, port).then(function (raw) {
    return new Promise(function (resolve, reject) {
      const socket = tls.connect({ socket: raw, servername: u.hostname }, function () {
        socket.write(
          'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
          'Host: ' + u.hostname + '\r\n' +
          'User-Agent: XunWanJuan/1.0 (local book search)\r\n' +
          'Accept: application/json,text/plain,*/*\r\n' +
          'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n' +
          (extraHeaders || '') +
          'Connection: close\r\n\r\n'
        );
      });
      const chunks = [];
      let settled = false;
      socket.on('data', function (c) { chunks.push(c); });
      socket.on('error', function (e) { if (!settled) { settled = true; reject(e); } });
      socket.on('end', function () {
        if (settled) return;
        settled = true;
        try {
          const all = Buffer.concat(chunks);
          const idx = all.indexOf('\r\n\r\n', 0, 'latin1');
          if (idx < 0) { reject(new Error('BAD_RESPONSE')); return; }
          const head = all.slice(0, idx).toString('latin1');
          const status = Number((head.split('\r\n')[0] || '').split(' ')[1]) || 0;
          const loc = (head.match(/^location:\s*(.+)$/im) || [])[1];
          let buf = all.slice(idx + 4);
          // 关键：OL 走隧道时是 chunked 编码，必须解码后再交给 JSON.parse
          if (/transfer-encoding:\s*chunked/i.test(head)) buf = dechunk(buf);
          resolve({ status: status, buf: buf, body: buf.toString('utf8'), location: loc ? loc.trim() : '',
            contentType: (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || '', headBuf: head.slice(0, 2048) });
        } catch (e) { reject(e); }
      });
    });
  });
}

/* 直连基本不通的境外书库域名；豆瓣走国内线路，直连即可（此处不列入） */
const PROXY_FIRST = /(^|\.)(openlibrary\.org|archive\.org|googleapis\.com|googleusercontent\.com|google\.com|books\.google\.[a-z.]+)$/i;

/** 原始取回（文本），返回 { status, body } */
async function rawGet(urlStr, forceProxy) {
  const proxy = await PROXY_READY;
  const u = new URL(urlStr);
  const referer = refererFor(u.hostname);
  const extra = referer ? { Referer: referer } : null;
  const preferProxy = forceProxy || (proxy && PROXY_FIRST.test(u.hostname));

  if (proxy && preferProxy) {
    // 代理优先，同时并行试一次直连，谁先成功用谁（避免任一链路卡死拖慢整体）
    const tasks = [requestViaProxy(urlStr, proxy, referer ? 'Referer: ' + referer + '\r\n' : '')];
    if (!forceProxy) tasks.push(requestDirect(urlStr, extra));
    return firstSuccess(tasks);
  }

  if (proxy) {
    try { return await requestDirect(urlStr, extra); }
    catch { return requestViaProxy(urlStr, proxy, referer ? 'Referer: ' + referer + '\r\n' : ''); }
  }
  try {
    return await requestDirect(urlStr, extra);
  } catch (e) {
    throw new Error('直连失败：' + (e.code || e.message) + '（未探测到本机代理，请先开启代理软件）');
  }
}

/** 多个请求赛跑，取第一个成功且状态码正常的 */
function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    const errors = [];
    if (!pending) { reject(new Error('NO_ROUTE')); return; }
    promises.forEach((p) => {
      Promise.resolve(p).then((res) => {
        if (res && res.status >= 200 && res.status < 400) { resolve(res); return; }
        errors.push('HTTP ' + (res && res.status));
        if (--pending === 0) reject(new Error(errors.join('；') || 'ALL_FAILED'));
      }).catch((e) => {
        errors.push((e.status ? 'HTTP ' + e.status + ' ' : '') + (e.code || e.message));
        if (--pending === 0) reject(new Error(errors.join('；') || 'ALL_FAILED'));
      });
    });
  });
}

async function getRaw(urlStr, forceProxy) {
  const host = new URL(urlStr).hostname;
  if (breakerDown(host)) throw new Error('SKIPPED_BY_BREAKER（该数据源连续失败，已暂时停用）');
  try {
    const res = await getRawInner(urlStr, forceProxy);
    breakerOk(host);
    return res;
  } catch (e) {
    breakerFail(host);
    throw e;
  }
}

async function getRawInner(urlStr, forceProxy) {
  let target = urlStr;
  for (let hop = 0; hop < 4; hop++) {
    const res = await rawGet(target, forceProxy);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      target = new URL(res.location, target).toString();   // 封面/档案常在此跳转
      continue;
    }
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return res;
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

async function getJSON(urlStr) {
  const res = await getRaw(urlStr);
  return JSON.parse(decodeBody(res));
}

/* ---------------- 图片代理（封面也常被墙，需经后端转发） ---------------- */

const IMG_HOSTS = /(^|\.)(openlibrary\.org|archive\.org|googleusercontent\.com|googleapis\.com|books\.google\.[a-z.]+|doubanio\.com)$/i;
// 豆瓣图床有防盗链：缺 Referer 会返回 418，必须带上
const IMG_REFERER = /(^|\.)(openlibrary\.org|archive\.org|doubanio\.com)$/i;
const IMG_REFERER_VALUE = {
  'doubanio.com': 'https://book.douban.com/',
  'openlibrary.org': 'https://openlibrary.org/',
  'archive.org': 'https://archive.org/'
};
function refererFor(hostname) {
  const m = hostname.match(/([a-z0-9-]+\.[a-z.]+)$/i);
  const base = m ? m[1].toLowerCase() : hostname.toLowerCase();
  const hit = Object.keys(IMG_REFERER_VALUE).find((k) => base === k || base.endsWith('.' + k));
  return hit ? IMG_REFERER_VALUE[hit] : '';
}
const IMG_CACHE = new Map();
const IMG_TTL = 24 * 60 * 60 * 1000;

function imagePlaceholder() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 68" width="48" height="68">' +
    '<rect width="48" height="68" fill="#efe9dd"/>' +
    '<g fill="none" stroke="#b6ab97" stroke-width="1.4" stroke-linejoin="round">' +
    '<rect x="9.5" y="8.5" width="29" height="51"/><path d="M16 8.5v51"/><path d="M21 22h12M21 30h12M21 38h8"/>' +
    '</g></svg>', 'utf8');
}

async function fetchImage(urlStr) {
  const hit = IMG_CACHE.get(urlStr);
  if (hit && Date.now() - hit.at < IMG_TTL) return hit;
  if (!IMG_HOSTS.test(new URL(urlStr).hostname)) throw new Error('HOST_NOT_ALLOWED');

  const res = await getRaw(urlStr, true);          // 封面一律走代理链路，稳定且可缓存（自动跟随跳转）
  const buf = res.buf || Buffer.from(res.body || '', 'utf8');
  const hex = buf.slice(0, 4).toString('hex').toLowerCase();
  const isPlaceholder = buf.slice(0, 200).toString('utf8').indexOf('<svg') >= 0;
  const type = hex.startsWith('ffd8ff') ? 'image/jpeg'
    : hex.startsWith('89504e47') ? 'image/png'
    : hex.startsWith('47494638') ? 'image/gif'
    : (hex.startsWith('52494646') ? 'image/webp' : (isPlaceholder ? 'image/svg+xml' : 'image/jpeg'));
  const entry = { at: Date.now(), buf: buf, type: type };
  // 占位图（取图失败）不写缓存，下次访问可以重试
  if (!isPlaceholder && buf.length > 500) {
    IMG_CACHE.set(urlStr, entry);
    if (IMG_CACHE.size > 400) IMG_CACHE.delete(IMG_CACHE.keys().next().value);
  }
  return entry;
}

/* ---------------- 简单缓存（只缓存成功结果） ---------------- */

const cache = new Map();
function cached(key, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL) return Promise.resolve(hit.value);
  return producer().then((value) => {
    const failed = !value || (value.total === 0 && (value.sources || []).every((s) => !s.ok));
    if (!failed) cache.set(key, { at: now, value });
    return value;
  });
}

/* ---------------- 数据规整 ---------------- */

function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(' / ');
  if (typeof v === 'object' && typeof v.value === 'string') return v.value.trim();
  return '';
}
const flat = (v) => str(v).replace(/\s+/g, ' ').trim();
const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s || '');
const isbnDigits = (s) => String(s || '').replace(/[^0-9Xx]/g, '');

function stripTags(v) {
  return String(v || '')
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const olCover = (id, size) => (id ? OL_COVERS + '/b/id/' + id + '-' + (size || 'L') + '.jpg' : '');
const olIsbnCover = (isbn, size) => (isbn ? OL_COVERS + '/b/isbn/' + isbn + '-' + (size || 'L') + '.jpg' : '');

function normalizeOl(doc) {
  const isbns = (doc.isbn || []).map(isbnDigits).filter((v) => v.length === 10 || v.length === 13);
  const b = {
    key: 'ol:' + (doc.key || doc.title),
    source: 'ol',
    title: flat(doc.title) || '（无题）',
    subtitle: flat(doc.subtitle),
    authors: (doc.author_name || []).map(flat).filter(Boolean).slice(0, 4),
    year: str(doc.first_publish_year) || str((doc.publish_year || [])[0]),
    publishers: (doc.publisher || []).map(flat).filter(Boolean).slice(0, 3),
    coverUrl: olCover(doc.cover_i, 'L'),
    coverSmall: olCover(doc.cover_i, 'M'),
    coverFallback: doc.cover_edition_key ? olCover(doc.cover_edition_key, 'L') : '',
    olKey: str(doc.key),
    olEditionKey: doc.cover_edition_key ? '/books/' + str(doc.cover_edition_key) : (doc.edition_key ? '/books/' + str((doc.edition_key || [])[0]) : ''),
    coverEditionKey: doc.cover_edition_key ? '/books/' + str(doc.cover_edition_key) : '',
    olUrl: doc.key ? OL + str(doc.key) : '',
    isbn: isbns.slice(0, 3),
    editions: Number(doc.edition_count) || 0,
    pages: Number(doc.number_of_pages_median) || 0,
    languages: (doc.language || []).slice(0, 4),
    subjects: (doc.subject || []).map(flat).filter(Boolean).slice(0, 12),
    rating: Number(doc.ratings_average) || 0,
    ratingCount: Number(doc.ratings_count) || 0,
    description: '',
    googleUrl: '',
    gbId: ''
  };
  if (!b.coverUrl && isbns.length) b.coverUrl = olIsbnCover(isbns[0], 'L');
  if (!b.coverSmall && isbns.length) b.coverSmall = olIsbnCover(isbns[0], 'M');
  return b;
}

const httpsify = (u) => String(u || '').replace(/^http:\/\//i, 'https://');

/* ---------------- 数据源：豆瓣（中文书主力，走国内线路，快） ---------------- */

const DB_ID = /subject\/(\d+)/;
const DB_DESC = {};                  // OL/豆瓣 的详情缓存

function normalizeDouban(item) {
  const url = str(item.url);
  const idm = url.match(DB_ID);
  const isbn = isbnDigits(item.id);
  const cover = httpsify(str(item.pic));
  return {
    key: 'db:' + (idm ? idm[1] : item.title),
    source: 'db',
    title: flat(item.title) || '（无题）',
    subtitle: flat(item.sub_title),
    authors: [flat(item.author_name)].filter(Boolean),
    year: str(item.year),
    publishers: [],
    coverUrl: cover,
    coverSmall: cover,
    coverFallback: '',
    olKey: '', olUrl: '', olEditionKey: '', coverEditionKey: '',
    isbn: (isbn.length === 10 || isbn.length === 13) ? [isbn] : [],
    editions: 0,
    pages: 0,
    languages: [],
    subjects: [],
    rating: Number(item.rating && item.rating.value) || 0,
    ratingCount: Number(item.rating && item.rating.count) || 0,
    description: '',
    googleUrl: '',
    gbId: '',
    dbId: idm ? idm[1] : '',
    dbUrl: idm ? DOUBAN + '/subject/' + idm[1] + '/' : url
  };
}

async function searchDouban(q) {
  const url = DOUBAN + '/j/subject_suggest?q=' + encodeURIComponent(q);
  const data = JSON.parse(decodeBody(await getRaw(url)));
  if (!Array.isArray(data)) return [];
  return data.filter((x) => x.title).map(normalizeDouban);
}

/** 从豆瓣页面提取中文简介：兼容桌面版（div.intro）与手机版（section-intro_desc）两种版式 */
function extractDoubanDescription(html) {
  const candidates = [];

  // 1) 桌面版：#link-report 内的 div.intro（最完整，可能是多个 <p>）
  const report = html.match(/id="link-report"[\s\S]{0,200}?<div class="intro">([\s\S]*?)<\/div>\s*<\/span>/i) ||
    html.match(/id="link-report"[\s\S]{0,4000}?<div class="intro">([\s\S]*?)<\/div>/i);
  if (report) candidates.push(stripTags(report[1]));

  // 2) 手机版：<p class="section-intro_desc">
  const sec = html.match(/class="section-intro_desc"[^>]*>([\s\S]*?)<\/p>/i);
  if (sec) candidates.push(stripTags(sec[1]));

  // 3) 兜底：og:description（形如「书名 豆瓣评分：9.1 简介：正文」，可能被截断）
  const meta = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i) ||
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (meta) {
    let t = stripTags(meta[1]);
    t = t.replace(/^[\s\S]{0,60}?豆瓣评分[：:]\s*[\d.]+\s*/, '').replace(/^简介[：:]\s*/, '').trim();
    if (!/介绍、书评、论坛及推荐/.test(t) || t.length > 60) candidates.push(t);
  }

  // 选最长的一条，并去掉结尾的省略号
  let best = '';
  candidates.forEach((c) => {
    const v = String(c || '').replace(/[\s.．…]+$/, '').trim();
    if (v.length > best.length) best = v;
  });
  // 正文里偶有「展开全部」等按钮文案
  best = best.replace(/（?展开全部）?$/, '').trim();
  return best;
}

/** 从豆瓣手机版页面取中文简介 */
async function fetchDoubanDetail(book) {
  if (DB_DESC[book.key]) return DB_DESC[book.key];
  const id = book.dbId || (book.dbUrl || '').match(DB_ID);
  const sid = typeof id === 'string' ? id : (id ? id[1] : '');
  if (!sid) return null;

  const res = await getRaw(DOUBAN_M + '/book/subject/' + sid + '/');
  const html = decodeBody(res);

  // 正文简介段落 / 桌面版 intro
  const desc = extractDoubanDescription(html);
  const meta = extractDoubanInfo(html);

  const tags = [...html.matchAll(/\/search\?search_text=([^"&]+)[^"]*"[^>]*>[^<]{1,20}<\/a>/g)]
    .map((m) => { try { return decodeURIComponent(m[1]).trim(); } catch { return ''; } })
    .filter((t) => t && t.length < 16);

  const out = {
    description: desc.trim(),
    rating: meta.rating,
    publisher: meta.publisher,
    year: meta.year,
    pages: meta.pages,
    price: meta.price,
    isbn: meta.isbn,
    subjects: [...new Set(tags)].slice(0, 8)
  };
  DB_DESC[book.key] = out;
  return out;
}

/** 解析豆瓣页面的出版信息（兼容桌面版 <div id="info"> 与手机版 <ul class="subject-info">） */
function extractDoubanInfo(html) {
  const out = { publisher: '', pages: 0, isbn: '', year: '', price: '', rating: 0 };

  // 评分
  const rating = html.match(/<strong[^>]*class="rating_num"[^>]*>([\d.]+)<\/strong>/i) ||
    html.match(/<span[^>]*class="rating_nums"[^>]*>([\d.]+)<\/span>/i) ||
    html.match(/豆瓣评分[：:\s]*([\d.]+)/);
  if (rating) out.rating = Number(rating[1]) || 0;

  // 详情区文本：桌面版 #info，手机版 .subject-info
  const blocks = [];
  const infoBlock = html.match(/<div[^>]+id="info"[^>]*>([\s\S]*?)<\/div>/i);
  if (infoBlock) blocks.push(infoBlock[1]);
  const mobBlock = html.match(/<ul[^>]*class="[^"]*subject-info[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (mobBlock) blocks.push(mobBlock[1]);
  // 兜底：整页范围内按标签逐项抓
  blocks.push(html);

  const pick = (label, re) => {
    for (const b of blocks) {
      const t = stripTags(b);
      const m = t.match(new RegExp(label + '[:：]\\s*([^\\n]{1,40})'));
      if (m) {
        const v = m[1].split(/\s{2,}|\/|\u00a0/)[0].trim();
        if (v) return v;
      }
      if (re) { const m2 = b.match(re); if (m2) return flat(stripTags(m2[1])); }
    }
    return '';
  };

  out.publisher = pick('出版社', /出版社[:：]?<\/span>\s*(?:<a[^>]*>)?\s*([^<\n]{1,40})/i);
  out.year = pick('出版年', /出版年[:：]?<\/span>\s*([^<\n]{1,20})/i);
  out.price = pick('定价', /定价[:：]?<\/span>\s*([^<\n]{1,20})/i);
  const pagesRaw = pick('页数', /页数[:：]?<\/span>\s*([^<\n]{1,20})/i);
  out.pages = Number((pagesRaw.match(/\d{2,5}/) || [])[0]) || 0;
  out.isbn = (pick('ISBN', /ISBN[:：]?<\/span>\s*([^<\n]{1,24})/i).match(/[\dXx-]{10,20}/) || [''])[0].replace(/[^0-9Xx]/g, '');

  if (out.isbn && out.isbn.length !== 10 && out.isbn.length !== 13) out.isbn = '';
  return out;
}

function normalizeGb(item) {
  const v = item.volumeInfo || {};
  const isbns = (v.industryIdentifiers || []).map((x) => isbnDigits(x.identifier))
    .filter((x) => x.length === 10 || x.length === 13);
  const img = v.imageLinks || {};
  return {
    key: 'gb:' + (item.id || v.title),
    source: 'gb',
    title: flat(v.title) || '（无题）',
    subtitle: flat(v.subtitle),
    authors: (v.authors || []).map(flat).filter(Boolean).slice(0, 4),
    year: str(v.publishedDate).slice(0, 4),
    publishers: [flat(v.publisher)].filter(Boolean),
    coverUrl: httpsify(img.thumbnail || img.smallThumbnail || ''),
    coverSmall: httpsify(img.smallThumbnail || img.thumbnail || ''),
    coverFallback: '',
    olKey: '', olUrl: '',
    isbn: isbns.slice(0, 3),
    editions: 0,
    pages: Number(v.pageCount) || 0,
    languages: [flat(v.language)].filter(Boolean),
    subjects: (v.categories || []).map(flat).filter(Boolean).slice(0, 12),
    rating: Number(v.averageRating) || 0,
    ratingCount: Number(v.ratingsCount) || 0,
    description: stripTags(v.description || ''),
    googleUrl: str(v.infoLink) || (item.id ? 'https://books.google.com/books?id=' + item.id : ''),
    gbId: str(item.id)
  };
}

const normTitle = (t) => flat(t).toLowerCase().replace(/[\s:：·,，.。\-—_()（）\[\]【】《》'"]/g, '');

function enrich(target, extra) {
  const fill = (k) => { if (!target[k] && extra[k]) target[k] = extra[k]; };
  ['coverUrl', 'coverSmall', 'coverFallback', 'rating', 'ratingCount', 'pages', 'year', 'description',
    'googleUrl', 'gbId', 'olUrl', 'olKey', 'subtitle'].forEach(fill);
  ['publishers', 'isbn', 'subjects', 'authors', 'languages'].forEach((k) => {
    if ((!target[k] || !target[k].length) && extra[k] && extra[k].length) target[k] = extra[k];
  });
  if (extra.description && target.description && !hasCJK(target.description) && hasCJK(extra.description)) {
    target.description = extra.description;
  }
}

function mergeLists(lists) {
  const out = [];
  const byTitle = new Map();
  lists.forEach((list) => (list || []).forEach((book) => {
    if (!book || !book.title) return;
    const k = normTitle(book.title);
    if (byTitle.has(k)) { enrich(byTitle.get(k), book); return; }
    byTitle.set(k, book);
    out.push(book);
  }));
  return out.sort((a, b) => {
    // 豆瓣（中文源）优先，其次看信息完整度
    if (a.source !== b.source) {
      if (a.source === 'db') return -1;
      if (b.source === 'db') return 1;
    }
    const s = (x) => (x.coverUrl ? 2 : 0) + (x.year ? 1 : 0) + (x.description ? 1 : 0) + (x.rating ? 1 : 0);
    return s(b) - s(a);
  });
}

/* ---------------- 业务：检索 / 详情 ---------------- */

async function searchOpenLibrary(q) {
  const base = '/search.json?limit=30&fields=key,title,subtitle,author_name,first_publish_year,publish_year,' +
    'publisher,cover_i,cover_edition_key,edition_count,isbn,language,subject,number_of_pages_median,ratings_average,ratings_count';
  // 注意：不要加 language:(chi) 过滤器，OL 的中文语言字段覆盖率很低，加了会几乎筛空
  const url = OL + base + '&q=' + encodeURIComponent(q);
  const data = await getJSON(url);
  const books = (data.docs || []).map(normalizeOl);

  if (!hasCJK(q)) return books;
  // 中文查询：中文条目排前面，其余保留在后
  const zh = books.filter((b) =>
    b.languages.some((l) => new RegExp('^(' + CN_LANG + ')', 'i').test(l)) || hasCJK(b.title));
  const rest = books.filter((b) => zh.indexOf(b) === -1);
  return zh.concat(rest);
}

async function searchGoogleBooks(q) {
  const url = GB + '?q=' + encodeURIComponent(q) + '&maxResults=30&printType=books&orderBy=relevance';
  const data = await getJSON(url);
  return (data.items || []).map(normalizeGb);
}

async function apiSearch(q, opts) {
  const wantOl = opts.ol !== false;
  const wantGb = opts.gb !== false;
  const wantDb = ENABLE_DOUBAN && opts.db !== false;   // 豆瓣为可插拔的本地源
  const cacheKey = 'q:' + q + ':' + wantOl + wantGb + wantDb;

  return cached(cacheKey, async () => {
    const jobs = [];
    if (wantDb) jobs.push(searchDouban(q).then((r) => ({ src: '豆瓣', ok: true, items: r }))
      .catch((e) => ({ src: '豆瓣', ok: false, error: e.message })));
    if (wantOl) jobs.push(searchOpenLibrary(q).then((r) => ({ src: 'Open Library', ok: true, items: r }))
      .catch((e) => ({ src: 'Open Library', ok: false, error: e.message })));
    if (wantGb) jobs.push(searchGoogleBooks(q).then((r) => ({ src: 'Google Books', ok: true, items: r }))
      .catch((e) => ({ src: 'Google Books', ok: false, error: e.message })));

    const settledAll = await Promise.all(jobs);
    const okOnes = settledAll.filter((s) => s.ok && s.items.length);
    // 中文源优先：豆瓣结果排在前面
    okOnes.sort((a, b) => (a.src === '豆瓣' ? -1 : 0) - (b.src === '豆瓣' ? -1 : 0));
    const items = mergeLists(okOnes.map((s) => s.items));

    // 后台预热前几条中文简介：等用户点选时已就绪（豆瓣单页约 1 秒，限并发不拖慢检索）
    if (wantDb) {
      const targets = items.filter((b) => b.source === 'db').slice(0, 6);
      Promise.all(targets.map((b, i) => new Promise((r) => setTimeout(r, i * 120))
        .then(() => fetchDoubanDetail(b)).catch(() => null))).catch(() => {});
    }

    return {
      query: q,
      total: items.length,
      items,
      sources: settledAll.map((s) => ({ name: s.src, ok: s.ok, count: s.ok ? s.items.length : 0, error: s.ok ? '' : s.error })),
      proxy: PROXY ? PROXY.host + ':' + PROXY.port : null,
      douban: ENABLE_DOUBAN
    };
  });
}

/* 流式检索：豆瓣结果先发一帧（约 0.3 秒），Open Library 到达后再补一帧。
   逐行 NDJSON，浏览器边收边渲染，避免为等慢数据源而空等十几秒。 */
async function apiSearchStream(q, opts, send) {
  const wantOl = opts.ol !== false;
  const wantGb = opts.gb !== false;
  const wantDb = ENABLE_DOUBAN && opts.db !== false;

  const collected = [];
  let all = [];
  let hasSent = false;

  const emit = (done, extra) => {
    all = mergeLists(collected);
    const payload = Object.assign({
      query: q,
      done: done,
      total: all.length,
      items: all,
      sources: extra.sources,
      proxy: PROXY ? PROXY.host + ':' + PROXY.port : null,
      douban: ENABLE_DOUBAN
    }, extra);
    if (!done) delete payload.ms;
    send(payload);
    return payload;
  };

  const jobs = [];
  if (wantDb) jobs.push({ src: '豆瓣', p: searchDouban(q) });
  if (wantOl) jobs.push({ src: 'Open Library', p: searchOpenLibrary(q) });
  if (wantGb) jobs.push({ src: 'Google Books', p: searchGoogleBooks(q) });

  const states = jobs.map((j) => ({ name: j.src, ok: false, count: 0, error: '' }));
  let finished = 0;
  const total = jobs.length;

  await Promise.all(jobs.map((job, idx) =>
    Promise.resolve(job.p).then((items) => {
      const list = items || [];
      states[idx] = { name: job.src, ok: true, count: list.length, error: '' };
      if (list.length) collected.push(list);
    }).catch((e) => {
      states[idx] = { name: job.src, ok: false, count: 0, error: e.message };
    }).then(() => {
      finished++;
      if (!hasSent) {
        hasSent = true;
        emit(false, { sources: states.slice(), pending: total - finished });   // 第一帧：先给最快的数据源
      }
    })));

  emit(true, { sources: states.slice(), pending: 0 });               // 收尾帧
  cache.set('q:' + q + ':' + wantOl + wantGb + wantDb, { at: Date.now(), value: {
    query: q, total: all.length, items: all, sources: states.slice(),
    proxy: PROXY ? PROXY.host + ':' + PROXY.port : null, douban: ENABLE_DOUBAN
  } });
}

/* 按书名+作者定位 Google Books 记录（中文书简介的主要来源） */
async function findGbForBook(book) {
  const q = 'intitle:' + JSON.stringify(book.title);
  const url = GB + '?q=' + encodeURIComponent(q) + '&maxResults=5&printType=books';
  const data = await getJSON(url);
  const items = (data.items || []).map(normalizeGb);
  if (!items.length) return null;

  const nt = normTitle(book.title);
  const author = (book.authors || [])[0] || '';
  let best = items.find((x) => normTitle(x.title) === nt &&
    (!author || !x.authors.length || x.authors.some((a) => a === author || a.indexOf(author) >= 0 || author.indexOf(a) >= 0)));
  if (!best) best = items.find((x) => normTitle(x.title) === nt);
  return best || null;
}

async function apiBook(book) {
  if (!book) return null;
  const copy = Object.assign({}, book);
  const jobs = [];

  /* 0) 豆瓣：中文简介的主要来源，直接取单页（约 1 秒，通常已在缓存中） */
  if (copy.source === 'db') {
    jobs.push(fetchDoubanDetail(copy).then((d) => {
      if (!d) return;
      if (d.description) copy.description = d.description;
      if (!copy.rating && d.rating) copy.rating = d.rating;
      if (d.publisher) copy.publishers = [d.publisher];   // 豆瓣的出版社信息更准，优先采用
      if (!copy.year && d.year) copy.year = String(d.year).slice(0, 4);
      if (!copy.pages && d.pages) copy.pages = d.pages;
      if (!copy.isbn || !copy.isbn.length) { if (d.isbn) copy.isbn = [d.isbn]; }
      if (d.subjects && d.subjects.length && (!copy.subjects || !copy.subjects.length)) copy.subjects = d.subjects;
    }).catch(() => {}));
  }

  /* 1) 著作页 + 版本列表：并行取，避免串行累积延迟 */
  let editionsPromise = null;
  if (copy.source === 'ol' && copy.olKey) {
    jobs.push(getJSON(OL + copy.olKey + '.json').then((work) => {
      const desc = str(work.description) || str(work.first_sentence);
      if (desc && !copy.description) copy.description = stripTags(desc);
      if ((!copy.subjects || !copy.subjects.length) && work.subjects) {
        copy.subjects = work.subjects.map(flat).slice(0, 12);
      }
    }).catch(() => {}));

    editionsPromise = getJSON(OL + copy.olKey + '/editions.json?limit=3').catch(() => null);
    jobs.push(editionsPromise.then(async (eds) => {
      if (copy.description || !eds) return;
      // 很多中文著作页没有简介，简介常写在具体版本记录里；三个版本并行探测
      const keys = ((eds.entries || []).map((e) => str(e.key)).filter(Boolean)).slice(0, 3);
      const found = await Promise.all(keys.map((k) =>
        getJSON(OL + k + '.json').then((ed) => str(ed.description) || str(ed.first_sentence) || '')
          .catch(() => '')));
      const hit = found.find((d) => d && d.length > 12);
      if (hit && !copy.description) copy.description = stripTags(hit);
    }));
  }

  /* 2) Google Books 兜底：OL 没有简介时按书名去找（含中文简介） */
  if (copy.source === 'ol') {
    jobs.push(Promise.resolve().then(async () => {
      if (copy.description) return;
      const gbBook = await findGbForBook(copy).catch(() => null);
      if (!gbBook) return;
      if (gbBook.description) copy.description = gbBook.description;
      if (!copy.coverUrl && gbBook.coverUrl) copy.coverUrl = gbBook.coverUrl;
      if (!copy.pages && gbBook.pages) copy.pages = gbBook.pages;
      if (!copy.rating && gbBook.rating) { copy.rating = gbBook.rating; copy.ratingCount = gbBook.ratingCount; }
      if (!copy.googleUrl && gbBook.googleUrl) { copy.googleUrl = gbBook.googleUrl; copy.gbId = gbBook.gbId; }
    }).catch(() => {}));
  }

  /* 3) GB 记录自身：取完整简介 */
  if (copy.source === 'gb' && copy.gbId && !copy.description) {
    jobs.push(getJSON(GB + '/' + encodeURIComponent(copy.gbId)).then((item) => {
      const v = item.volumeInfo || {};
      if (v.description) copy.description = stripTags(v.description);
      if (!copy.pages && v.pageCount) copy.pages = Number(v.pageCount);
    }).catch(() => {}));
  }

  await Promise.all(jobs);
  return copy;
}

/* ---------------- 首屏随机推荐 ---------------- */

/* 书池：只用书名检索，避免同名误配；混合中外、兼顾通俗与经典 */
const RECO_POOL = [
  '红楼梦', '西游记', '三国演义', '水浒传', '活着', '围城', '平凡的世界', '白鹿原',
  '三体', '百年孤独', '小王子', '老人与海', '1984', '月亮与六便士', '瓦尔登湖', '人类简史',
  '万历十五年', '呼兰河传', '边城', '解忧杂货店', '追风筝的人', '局外人', '动物农场', '房思琪的初恋乐园'
];

let RECO_CACHE = { at: 0, items: [] };
const RECO_TTL = 6 * 60 * 60 * 1000;   // 书池元数据缓存 6 小时

/* 受控并发：对同一数据源保持温和的请求节奏，避免被目标站点限流 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await worker(items[i], i); } catch { out[i] = null; }
    }
  });
  await Promise.all(runners);
  return out;
}

async function buildRecoPool() {
  const results = await mapLimit(RECO_POOL, 3, (title) =>
    searchDouban(title).then((list) => {
      const exact = list.find((b) => normTitle(b.title) === normTitle(title));
      const pick = exact || list[0];
      if (!pick || !pick.title) return null;
      return {
        title: pick.title,
        authors: pick.authors,
        year: pick.year,
        coverUrl: pick.coverUrl,
        coverSmall: pick.coverSmall,
        dbId: pick.dbId,
        dbUrl: pick.dbUrl,
        source: 'db'
      };
    }));

  return results.filter(Boolean);
}

/** 返回随机的 n 本书（只含封面与书名作者，不含简介） */
async function apiRecommend(n) {
  const count = Math.max(1, Math.min(9, Number(n) || 3));
  if (!ENABLE_DOUBAN) return { items: [], total: 0, disabled: true };   // 公开部署关闭豆瓣源时不出推荐

  if (!RECO_CACHE.items.length || Date.now() - RECO_CACHE.at > RECO_TTL) {
    const fresh = await buildRecoPool();
    if (fresh.length) RECO_CACHE = { at: Date.now(), items: fresh };
  }

  const pool = RECO_CACHE.items.slice();
  for (let i = pool.length - 1; i > 0; i--) {           // Fisher-Yates 洗牌
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return { items: pool.slice(0, count), total: pool.length };
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function sendJSON(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT, path.normalize(target).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + HOST); }
  catch { res.writeHead(400).end('Bad Request'); return; }

  const p = url.pathname;
  const t0 = Date.now();

  try {
    if (p === '/api/status') {
      const proxy = await PROXY_READY;
      sendJSON(res, 200, {
        ok: true,
        proxy: proxy ? proxy.host + ':' + proxy.port : null,
        proxyFrom: proxy ? proxy.from : null,
        douban: ENABLE_DOUBAN
      });
      return;
    }

    if (p === '/api/recommend') {
      const data = await apiRecommend(url.searchParams.get('n'));
      data.ms = Date.now() - t0;
      sendJSON(res, 200, data);
      return;
    }

    if (p === '/api/clear') {
      cache.clear();
      IMG_CACHE.clear();
      BREAKER.clear();          // 同时解除熔断，便于手动恢复数据源
      sendJSON(res, 200, { ok: true, cleared: true });
      return;
    }

    if (p === '/api/search/stream') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) { sendJSON(res, 400, { error: '缺少查询词 q' }); return; }
      const opts = { ol: url.searchParams.get('ol') !== '0', gb: url.searchParams.get('gb') !== '0', db: url.searchParams.get('db') !== '0' };

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (res.flushHeaders) res.flushHeaders();

      const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch { /* 连接已断 */ } };
      try {
        await apiSearchStream(q, opts, send);
      } catch (e) {
        send({ query: q, done: true, total: 0, items: [], sources: [], error: String(e.message || e) });
      }
      res.end();
      return;
    }

    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) { sendJSON(res, 400, { error: '缺少查询词 q' }); return; }
      const data = await apiSearch(q, {
        ol: url.searchParams.get('ol') !== '0',
        gb: url.searchParams.get('gb') !== '0'
      });
      data.ms = Date.now() - t0;
      sendJSON(res, 200, data);
      return;
    }

    if (p === '/img') {
      const src = url.searchParams.get('u') || '';
      let payload;
      if (!src) payload = { buf: imagePlaceholder(), type: 'image/svg+xml' };
      else {
        try { payload = await fetchImage(src); }
        catch { payload = { buf: imagePlaceholder(), type: 'image/svg+xml' }; }
      }
      res.writeHead(200, {
        'Content-Type': payload.type,
        'Content-Length': payload.buf.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(payload.buf);
      return;
    }

    if (p === '/api/book' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 200000) req.destroy(); });
      req.on('end', async () => {
        try {
          const data = await apiBook(JSON.parse(raw || '{}'));
          sendJSON(res, 200, data || {});
        } catch (e) {
          sendJSON(res, 500, { error: String(e.message || e) });
        }
      });
      return;
    }

    if (p.startsWith('/api/')) { sendJSON(res, 404, { error: '未知接口 ' + p }); return; }

    serveStatic(res, p);
  } catch (e) {
    sendJSON(res, 502, {
      error: '取书失败：' + String(e.message || e),
      hint: '请确认本机代理（如 Clash/V2Ray）已开启；也可尝试在浏览器里改用直连模式。'
    });
  }
});

/* ---------------- 启动 ---------------- */

PROXY_READY = detectProxy().then((proxy) => {
  PROXY = proxy;
  return proxy;
});

server.listen(PORT, HOST, async () => {
  const proxy = await PROXY_READY;
  console.log('寻万卷书 已启动: http://' + HOST + ':' + PORT + '/');
  console.log(proxy
    ? '出网方式: 本机代理 ' + proxy.host + ':' + proxy.port + '（' + (proxy.from === 'env' ? '来自环境变量' : '自动探测') + '），直连失败时自动改走代理'
    : '出网方式: 直连（未探测到本机代理；若书库访问不通，请先开启代理软件）');

  // 启动后预热推荐书池，让首屏「随机三本」秒开（豆瓣源关闭时跳过）
  if (ENABLE_DOUBAN) {
    apiRecommend(3).then((r) => {
      console.log('推荐书池已就绪: ' + r.total + ' 本可随机推荐');
    }).catch(() => {});
  } else {
    console.log('豆瓣源已关闭（ENABLE_DOUBAN=0）：仅使用开放书库数据源，首屏不提供推荐。');
  }
});
