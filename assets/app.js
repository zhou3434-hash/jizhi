/* ===========================================================
   寻万卷书 · app.js
   书籍查询：封面 + 简介展示（不提供在线阅读）
   -----------------------------------------------------------
   两种取数方式，自动选择：
     1) 本地后端 /api/*  —— 由 server.js 代取书库数据与封面图
        （后端会走本机代理出网，可绕开直连受限与跨域问题）
     2) 浏览器直连公开接口 —— 后端不可用时的兜底
   =========================================================== */
(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */

  var CFG = {
    openLibrary: 'https://openlibrary.org',
    googleBooks: 'https://www.googleapis.com/books/v1/volumes',
    apiBase: '',          // 探测到后端后填入，如 ''
    timeout: 45000,       // 后端链路较慢，超时给足
    directTimeout: 15000,
    recLimit: 12,
    descClamp: 460
  };

  var RECOMMEND = ['红楼梦', '西游记', '三体', '平凡的世界', '百年孤独', '活着'];

  /* 数据源说明：豆瓣为可插拔的本地源，公开部署可在后端用 ENABLE_DOUBAN=0 关闭 */
  var SOURCE_NOTE = {
    db: '豆瓣（本地查询用，简介与封面来自其公开页面）',
    ol: 'Open Library（开放书目数据）',
    gb: 'Google Books'
  };
  var PLACEHOLDER_HINT = '首屏推荐基于豆瓣源，当前部署已关闭该源，请直接用搜索栏查询。';
  var PLACEHOLDER_EMPTY = '当前部署未启用中文推荐源（豆瓣），可在后端设置 ENABLE_DOUBAN=1 开启，或直接用搜索栏查询。';

  var CN_LANG = 'chi|zho|zh';

  /* ---------------- 小工具 ---------------- */

  var $ = function (id) { return document.getElementById(id); };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function text(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' / ');
    if (typeof value === 'object' && typeof value.value === 'string') return value.value.trim();
    return '';
  }

  function plain(value) { return text(value).replace(/\s+/g, ' ').trim(); }

  function stripTags(value) {
    return String(value || '')
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

  function hasCJK(s) { return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s || ''); }
  function isbnDigits(s) { return String(s || '').replace(/[^0-9Xx]/g, ''); }
  function normTitle(t) { return plain(t).toLowerCase().replace(/[\s:：·,，.。\-—_()（）\[\]【】《》'"]/g, ''); }
  function httpsify(u) { return String(u || '').replace(/^http:\/\//i, 'https://'); }

  function requestJSON(url, opts) {
    opts = opts || {};
    var ms = opts.timeout || CFG.timeout;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- 后端探测器 ---------------- */

  function detectBackend() {
    return requestJSON('/api/status', { timeout: 4000 })
      .then(function (d) {
        if (d && d.ok) {
          CFG.apiBase = '';
          state.backend = true;
          state.proxy = d.proxy || '';
          state.douban = d.douban !== false;
          return true;
        }
        return false;
      })
      .catch(function () { state.backend = false; return false; });
  }

  /* ---------------- 直连兜底：数据规整 ---------------- */

  function normalizeOlDoc(doc) {
    var isbns = (doc.isbn || []).map(isbnDigits).filter(function (v) { return v.length === 10 || v.length === 13; });
    var cover = doc.cover_i ? CFG.openLibrary + '/b/id/' + doc.cover_i + '-L.jpg' : '';
    var book = {
      key: 'ol:' + (doc.key || doc.title),
      source: 'ol',
      title: plain(doc.title) || '（无题）',
      subtitle: plain(doc.subtitle),
      authors: (doc.author_name || []).map(plain).slice(0, 4),
      year: text(doc.first_publish_year),
      publishers: (doc.publisher || []).map(plain).slice(0, 3),
      coverUrl: cover,
      coverSmall: doc.cover_i ? CFG.openLibrary + '/b/id/' + doc.cover_i + '-M.jpg' : '',
      coverFallback: doc.cover_edition_key ? CFG.openLibrary + '/b/id/' + doc.cover_edition_key + '-L.jpg' : '',
      olKey: text(doc.key),
      olUrl: doc.key ? CFG.openLibrary + doc.key : '',
      isbn: isbns.slice(0, 3),
      editions: Number(doc.edition_count) || 0,
      pages: Number(doc.number_of_pages_median) || 0,
      languages: (doc.language || []).slice(0, 4),
      subjects: (doc.subject || []).map(plain).slice(0, 12),
      rating: Number(doc.ratings_average) || 0,
      ratingCount: Number(doc.ratings_count) || 0,
      description: '', googleUrl: '', gbId: ''
    };
    if (!book.coverUrl && isbns.length) book.coverUrl = CFG.openLibrary + '/b/isbn/' + isbns[0] + '-L.jpg';
    return book;
  }

  function normalizeGbItem(item) {
    var v = item.volumeInfo || {};
    var img = v.imageLinks || {};
    var isbns = (v.industryIdentifiers || []).map(function (x) { return isbnDigits(x.identifier); })
      .filter(function (x) { return x.length === 10 || x.length === 13; });
    return {
      key: 'gb:' + (item.id || v.title),
      source: 'gb',
      title: plain(v.title) || '（无题）',
      subtitle: plain(v.subtitle),
      authors: (v.authors || []).map(plain).slice(0, 4),
      year: text(v.publishedDate).slice(0, 4),
      publishers: [plain(v.publisher)].filter(Boolean),
      coverUrl: httpsify(img.thumbnail || img.smallThumbnail || ''),
      coverSmall: httpsify(img.smallThumbnail || img.thumbnail || ''),
      coverFallback: '',
      olKey: '', olUrl: '',
      isbn: isbns.slice(0, 3),
      editions: 0,
      pages: Number(v.pageCount) || 0,
      languages: [plain(v.language)].filter(Boolean),
      subjects: (v.categories || []).map(plain).slice(0, 12),
      rating: Number(v.averageRating) || 0,
      ratingCount: Number(v.ratingsCount) || 0,
      description: stripTags(v.description || ''),
      googleUrl: text(v.infoLink) || (item.id ? 'https://books.google.com/books?id=' + item.id : ''),
      gbId: text(item.id)
    };
  }

  function directSearchOpenLibrary(q) {
    var base = '/search.json?limit=30&fields=key,title,subtitle,author_name,first_publish_year,publisher,' +
      'cover_i,cover_edition_key,edition_count,isbn,language,subject,number_of_pages_median,ratings_average,ratings_count';
    var cn = hasCJK(q);
    var url = CFG.openLibrary + base + '&q=' + encodeURIComponent(cn ? q + ' language:(' + CN_LANG + ')' : q);
    return requestJSON(url, { timeout: CFG.directTimeout }).then(function (data) {
      var docs = data.docs || [];
      if (!docs.length && cn) {
        return requestJSON(CFG.openLibrary + base + '&q=' + encodeURIComponent(q), { timeout: CFG.directTimeout })
          .then(function (d2) { return (d2.docs || []).map(normalizeOlDoc); });
      }
      var books = docs.map(normalizeOlDoc);
      if (cn) {
        var zh = books.filter(function (b) {
          return b.languages.some(function (l) { return new RegExp('^(' + CN_LANG + ')', 'i').test(l); }) || hasCJK(b.title);
        });
        books = zh.concat(books.filter(function (b) { return zh.indexOf(b) === -1; }));
      }
      return books;
    });
  }

  function directSearchGoogleBooks(q) {
    var url = CFG.googleBooks + '?q=' + encodeURIComponent(q) + '&maxResults=30&printType=books&orderBy=relevance';
    return requestJSON(url, { timeout: CFG.directTimeout }).then(function (data) {
      return (data.items || []).map(normalizeGbItem);
    });
  }

  /* 直连豆瓣（国内可直连），用于后端不可用时的推荐兜底 */
  function searchDoubanDirect(q) {
    var url = 'https://book.douban.com/j/subject_suggest?q=' + encodeURIComponent(q);
    return requestJSON(url, { timeout: CFG.directTimeout }).then(function (data) {
      if (!Array.isArray(data)) return [];
      return data.filter(function (x) { return x.title; }).map(function (x) {
        return {
          key: 'db-direct:' + (x.id || x.title),
          source: 'db',
          title: plain(x.title),
          authors: [plain(x.author_name)].filter(Boolean),
          year: text(x.year),
          coverUrl: httpsify(x.pic),
          coverSmall: httpsify(x.pic),
          description: '', isbn: [], languages: [], subjects: [], publishers: [],
          pages: 0, editions: 0, rating: 0, ratingCount: 0,
          olUrl: '', googleUrl: '', olKey: '', gbId: '', dbId: '', dbUrl: text(x.url)
        };
      });
    });
  }

  /* ---------------- 合并去重 ---------------- */

  function enrich(target, extra) {
    ['coverUrl', 'coverSmall', 'coverFallback', 'rating', 'ratingCount', 'pages', 'year', 'description',
      'googleUrl', 'gbId', 'olUrl', 'olKey', 'subtitle'].forEach(function (k) {
      if (!target[k] && extra[k]) target[k] = extra[k];
    });
    ['publishers', 'isbn', 'subjects', 'authors', 'languages'].forEach(function (k) {
      if ((!target[k] || !target[k].length) && extra[k] && extra[k].length) target[k] = extra[k];
    });
    if (extra.description && target.description && !hasCJK(target.description) && hasCJK(extra.description)) {
      target.description = extra.description;
    }
  }

  function mergeBooks(lists) {
    var out = [], byTitle = {};
    lists.forEach(function (list) {
      (list || []).forEach(function (book) {
        if (!book || !book.title) return;
        var k = normTitle(book.title);
        if (byTitle[k]) { enrich(byTitle[k], book); return; }
        byTitle[k] = book;
        out.push(book);
      });
    });
    return out.sort(function (a, b) {
      var s = function (x) { return (x.coverUrl ? 2 : 0) + (x.year ? 1 : 0) + (x.description ? 1 : 0) + (x.rating ? 1 : 0); };
      return s(b) - s(a);
    });
  }

  /* ---------------- 统一取数接口 ---------------- */

  function apiSearch(q, opt) {
    var qs = '/api/search?q=' + encodeURIComponent(q) +
      '&db=' + (opt.useLocal ? '1' : '0') + '&ol=' + (opt.useGlobal ? '1' : '0');
    return requestJSON(qs).then(function (d) {
      return {
        items: d.items || [],
        sources: d.sources || [],
        proxy: d.proxy || '',
        ms: d.ms || 0
      };
    });
  }

  function apiBook(book) {
    return requestJSON('/api/book', {
      method: 'POST',
      body: JSON.stringify(book),
      timeout: CFG.timeout
    });
  }

  function directSearch(q, opt) {
    var jobs = [];
    if (opt.useGlobal) jobs.push(directSearchOpenLibrary(q));
    if (opt.useLocal) jobs.push(directSearchGoogleBooks(q));
    return Promise.allSettled(jobs).then(function (rs) {
      var lists = [], sources = [];
      rs.forEach(function (r) {
        var name = lists.length === 0 && opt.useGlobal ? 'Open Library' : 'Google Books';
        if (r.status === 'fulfilled') { lists.push(r.value); sources.push({ name: name, ok: true, count: r.value.length }); }
        else { sources.push({ name: name, ok: false, error: String(r.reason && r.reason.message || r.reason) }); }
      });
      return { items: mergeBooks(lists), sources: sources, proxy: '', ms: 0 };
    });
  }

  function sourceLabel(book) {
    if (book.source === 'db') return '豆瓣';
    if (book.source === 'gb') return 'Google Books';
    return 'Open Library';
  }

  /* 封面地址：走后端图片代理，避免封面被墙 */
  function coverSrc(url) {
    if (!url) return '';
    if (state.backend) return '/img?u=' + encodeURIComponent(url);
    return url;
  }

  function loadDetail(book) {
    if (state.backend) {
      return apiBook(book).catch(function () { return book; });
    }
    if (book.source === 'ol' && book.olKey && !book.description) {
      return requestJSON(CFG.openLibrary + book.olKey + '.json', { timeout: CFG.directTimeout })
        .then(function (w) {
          var d = text(w.description) || text(w.first_sentence);
          if (d) book.description = stripTags(d);
          return book;
        }).catch(function () { return book; });
    }
    return Promise.resolve(book);
  }

  /* ---------------- 流式检索（逐行 NDJSON，边收边渲染） ---------------- */

  /* 把 ReadableStream 按行切分——缓冲跨块保留，避免 JSON 被网络分块截断 */
  function readNDJSON(res, onEvent) {
    if (!res.body || !res.body.getReader) {
      return res.text().then(function (t) { return consumeNDJSON(t, onEvent); });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    return (function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          if (buf.trim()) consumeNDJSON(buf, onEvent);
          return;
        }
        buf += decoder.decode(r.value, { stream: true });
        var idx, n = 0;
        while ((idx = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          n++;
          consumeNDJSON(line, onEvent);
        }
        // 兜底：若浏览器迟迟不结束流，至少别无限增长
        if (buf.length > 4 * 1024 * 1024) buf = '';
        return pump();
      });
    })();
  }

  function consumeNDJSON(text, onEvent) {
    String(text).split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try { onEvent(JSON.parse(line)); } catch (e) { /* 忽略坏行 */ }
    });
  }

  function apiSearchStream(q, opt, onEvent) {
    var qs = '/api/search/stream?q=' + encodeURIComponent(q) +
      '&db=' + (opt.useLocal ? '1' : '0') + '&ol=' + (opt.useGlobal ? '1' : '0');
    return fetch(qs, { headers: { Accept: 'application/x-ndjson' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var last = null;
      return readNDJSON(res, function (ev) { last = ev; onEvent(ev); }).then(function () { return last; });
    });
  }

  /* ---------------- 状态 ---------------- */

  var state = {
    items: [], activeKey: -1, query: '', mode: 'search',
    backend: false, proxy: '', collapsed: false, loading: false, douban: true
  };

  function setState(kind, opt) {
    opt = opt || {};
    $('stateWelcome').hidden = kind !== 'welcome';
    $('stateLoading').hidden = kind !== 'loading';
    $('stateEmpty').hidden = !(kind === 'empty' || kind === 'error');
    $('book').hidden = kind !== 'book';

    if (kind === 'loading') {
      $('loadingText').textContent = opt.text || '正在检索……';
      $('loadingHint').textContent = opt.hint || '';
      $('retryBtn').hidden = true;
      var useSkeleton = opt.skeleton !== false;     // 默认用骨架屏，快速数据源到达即被真实结果取代
      $('loadingSkeleton').hidden = !useSkeleton;
      $('loadingSpinner').hidden = useSkeleton;
    }
    if (kind === 'empty' || kind === 'error') {
      $('emptyTitle').textContent = opt.title || '没有找到相关书籍';
      $('emptyText').innerHTML = opt.text || '';
      $('retryBtn').hidden = false;
    }
  }

  function renderStatus() {
    var mode = $('modeTag');
    if (state.backend) {
      mode.textContent = (state.proxy ? '已连接本地后端 · 出网代理 ' + state.proxy : '已连接本地后端 · 直连出网') +
        (state.douban ? '' : ' · 豆瓣源已关闭');
      mode.className = 'mode-tag is-ok';
    } else {
      mode.textContent = '未检测到本地后端，正在使用浏览器直连（可能受网络限制）';
      mode.className = 'mode-tag is-warn';
    }
  }

  /* ---------------- 检索主流程 ---------------- */

  function search(query, mode) {
    var q = plain(query);
    if (!q || state.loading) return;

    var useLocal = $('optLocal').checked;
    var useGlobal = $('optGlobal').checked;
    if (!useLocal && !useGlobal) { $('optLocal').checked = true; useLocal = true; }

    state.query = q;
    state.mode = mode || 'search';
    state.loading = true;
    $('searchBtn').disabled = true;
    $('results').hidden = true;
    $('detail').classList.remove('span-all');

    var t0 = Date.now();
    var ticker = setInterval(function () {
      var s = Math.round((Date.now() - t0) / 1000);
      $('loadingText').textContent = '正在检索「' + q + '」…… 已用时 ' + s + ' 秒';
    }, 500);

    setState('loading', { text: '正在检索「' + q + '」……', hint: loadingHint(), skeleton: true });

    var streamStarted = false;
    var finalRes = null;

    function stopTicker() { clearInterval(ticker); }

    function ensureLoader() {
      if (streamStarted) return;
      streamStarted = true;
      stopTicker();
      $('searchBtn').disabled = false;
    }

    function showPartial(res) {
      var items = res.items || [];
      if (!items.length) return;                 // 该数据源暂时没结果，继续等下一帧
      ensureLoader();
      state.items = items;
      state.okSources = (res.sources || []).filter(function (s) { return s.ok; });
      state.failedSources = (res.sources || []).filter(function (s) { return !s.ok; });
      renderResults();
      renderPartialHint(res);
      if ($('book').hidden) {
        selectBook(items[0], true);              // 第一帧就展示详情，不用等慢数据源
        $('detail').classList.add('span-all');   // 结果还在陆续到达，先不并排占位
      }
    }
    function renderPartialHint(res) {
      var pending = res.pending || 0;
      if (pending > 0) {
        var who = (res.sources || []).filter(function (s) { return s.ok; })
          .map(function (s) { return s.name; }).join('、');
        $('tip').textContent = (who ? '已显示 ' + who + ' 结果' : '正在检索') +
          ' · 正在补充其他数据源（全球书库较慢，约 8～15 秒）…';
      }
    }

    function done(res) {
      if (!res) {
        setState('error', { title: '暂时无法连接书库', text: errorText() });
        return;
      }
      var items = res.items || [];
      if (mode === 'recommend') items = items.slice(0, CFG.recLimit);

      // 用户在第一帧之后可能已经点了别的书，收尾时保持他的选择
      var activeKey = null;
      if (streamStarted && state.items[state.activeKey]) activeKey = state.items[state.activeKey].key;

      state.items = items;
      state.failedSources = (res.sources || []).filter(function (s) { return !s.ok; });
      state.okSources = (res.sources || []).filter(function (s) { return s.ok; });
      if (res.proxy) state.proxy = res.proxy;

      if (!items.length) {
        var allFailed = !state.okSources.length;
        setState(allFailed ? 'error' : 'empty', allFailed
          ? { title: '暂时无法连接书库', text: errorText() }
          : { title: '没有找到相关书籍', text: '没有检索到「' + esc(q) + '」的记录。可尝试更换关键词，或只输入作者名、ISBN 号码。' });
        $('results').hidden = true;
        $('detail').classList.add('span-all');
        return;
      }

      state.collapsed = false;
      renderResults();
      renderStatus();

      if (activeKey) {
        // 保留用户已选中的那本书，不把详情重置回第一条
        var keep = null;
        for (var i = 0; i < items.length; i++) { if (items[i].key === activeKey) { keep = items[i]; break; } }
        if (keep) { state.activeKey = items.indexOf(keep); markActive(); }
        $('detail').classList.remove('span-all');
      } else {
        selectBook(items[0], true);
      }

      if (!items[0].description) {
        loadDetail(items[0]).then(function (full) { renderDescription(full); });
      }
    }

    var fallbackToDirect = function () {
      return directSearch(q, { useLocal: useLocal, useGlobal: useGlobal })
        .then(done)
        .catch(function (e) { setState('error', { title: '暂时无法连接书库', text: errorText(e) }); });
    };

    var req = state.backend
      ? apiSearchStream(q, { useLocal: useLocal, useGlobal: useGlobal }, function (ev) {
          if (!ev) return;
          if (ev.done) { finalRes = ev; return; }
          showPartial(ev);
        })
      : fallbackToDirect();

    req.then(function () {
      if (state.backend) {
        if (finalRes && (finalRes.items || []).length) done(finalRes);
        else if (!streamStarted || !state.items.length) fallbackToDirect();   // 流没给出任何结果，退回一次性检索
        else done(finalRes);
      }
    }).catch(function () {
      if (state.backend && !streamStarted) fallbackToDirect();
      else if (!streamStarted) setState('error', { title: '暂时无法连接书库', text: errorText() });
    }).finally(function () {
      stopTicker();
      state.loading = false;
      $('searchBtn').disabled = false;
    });
  }

  function loadingHint() {
    if (!state.backend) return '浏览器直连模式：若长时间无响应，通常是网络无法直连书库。';
    return state.proxy
      ? '正在通过本机代理 ' + state.proxy + ' 访问书库，首次检索需 5～15 秒，请稍候。'
      : '正在访问书库，请稍候。';
  }

  function errorText(err) {
    var parts = ['可能是网络不通或接口访问受限。'];
    if (state.backend) {
      parts.push('后端已连接' + (state.proxy ? '（代理 ' + esc(state.proxy) + '）' : '') + '，但书库请求失败。');
      if (state.failedSources && state.failedSources.length) {
        parts.push('失败原因：' + esc(state.failedSources.map(function (s) {
          return s.name + ' ' + (s.error || '');
        }).join('；')) + '。');
      }
      parts.push('请确认代理软件已开启且能访问 openlibrary.org。');
    } else {
      parts.push('建议用 <code>node server.js</code> 启动本地服务后再访问 http://127.0.0.1:8099/。');
    }
    if (err) parts.push('（' + esc(String(err.message || err)) + '）');
    return parts.join(' ');
  }

  /* ---------------- 结果列表 ---------------- */

  function renderResults() {
    var list = $('resultList');
    $('results').hidden = false;
    $('detail').classList.toggle('span-all', state.collapsed);
    list.hidden = state.collapsed;

    list.innerHTML = state.items.map(function (b, i) {
      var cover = b.coverSmall
        ? '<img src="' + esc(coverSrc(b.coverSmall)) + '" alt="" loading="lazy" referrerpolicy="no-referrer"' +
          ' onerror="this.onerror=null;this.src=\'' + esc(coverSrc(b.coverSmall)) + '\';this.style.visibility=\'hidden\'">'
        : '';
      var sub = [b.authors.join('、'), b.year, (b.publishers || [])[0]].filter(Boolean).join(' · ');
      return '<li><button type="button" class="result-item" data-i="' + i + '">' +
        '<span class="mini-cover">' + (cover || '') + '</span>' +
        '<span class="result-text">' +
          '<span class="result-title">' + esc(b.title) + '</span>' +
          '<span class="result-sub">' + esc(sub || '—') + '</span>' +
        '</span></button></li>';
    }).join('');

    $('resultCount').textContent = '共 ' + state.items.length + ' 条';
    $('toggleResults').textContent = state.collapsed ? '展开' : '收起';

    var tip = [];
    if (state.okSources && state.okSources.length) {
      tip.push('来源：' + state.okSources.map(function (s) { return s.name + '（' + s.count + '）'; }).join(' + '));
    }
    if (state.mode === 'recommend') tip.push('以上为推荐书目，可在上方输入书名精确查询');
    $('tip').textContent = tip.join(' · ');
    $('moreHint').textContent = '';
  }

  function markActive() {
    var nodes = $('resultList').querySelectorAll('.result-item');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('is-active', i === state.activeKey);
    }
  }

  /* ---------------- 详情（左封面 / 右介绍） ---------------- */

  function setCover(book) {
    var frame = $('coverFrame');
    var cap = $('coverCap');
    var urls = [book.coverUrl, book.coverFallback].filter(Boolean).map(coverSrc);
    var tried = 0;

    frame.classList.remove('is-empty');
    cap.textContent = '';

    if (!urls.length) {
      frame.classList.add('is-empty');
      frame.innerHTML = COVER_SVG;
      cap.textContent = '暂无封面';
      return;
    }

    frame.innerHTML = '';
    var img = document.createElement('img');
    img.alt = '《' + book.title + '》封面';
    img.referrerPolicy = 'no-referrer';
    img.onerror = function () {
      tried++;
      if (tried < urls.length) { img.src = urls[tried]; return; }
      frame.classList.add('is-empty');
      frame.innerHTML = COVER_SVG;
      cap.textContent = '暂无封面';
    };
    img.onload = function () {
      frame.classList.remove('is-empty');
      cap.textContent = '封面来源：' + sourceLabel(book);
    };
    img.src = urls[0];
    frame.appendChild(img);
  }

  function renderDetail(book) {
    setState('book');

    $('crumb').textContent = (state.mode === 'recommend' ? '推荐' : '检索「' + state.query + '」') +
      ' · ' + sourceLabel(book);

    $('bookTitle').innerHTML = esc(book.title) +
      (book.subtitle ? '<span class="title-sub">' + esc(book.subtitle) + '</span>' : '');

    $('bookAuthor').innerHTML = book.authors.length
      ? esc(book.authors.join('、')) + ' <span class="muted">著</span>'
      : '<span class="muted">作者不详</span>';

    var badges = [];
    if (book.year) badges.push(esc(book.year) + ' 年');
    if (book.rating) badges.push('评分 ' + book.rating.toFixed(1) + (book.ratingCount ? '（' + book.ratingCount + ' 人）' : ''));
    if (book.editions) badges.push(book.editions + ' 个版本');
    $('bookBadges').innerHTML = badges.map(function (b) { return '<span class="badge">' + b + '</span>'; }).join('') +
      '<span class="badge src">' + sourceLabel(book) + '</span>';

    var rows = [
      ['作者', book.authors.join('、') || '不详'],
      ['出版年', book.year || '不详'],
      ['出版社', (book.publishers || []).join('、') || '不详'],
      ['页数', book.pages ? book.pages + ' 页' : ''],
      ['语言', (book.languages || []).join('、')],
      ['ISBN', (book.isbn || []).join('、')],
      ['版本数', book.editions ? book.editions + ' 种' : ''],
      ['评分', book.rating ? book.rating.toFixed(1) + ' / 5' : '']
    ].filter(function (r) { return r[1]; });

    $('bookMeta').innerHTML = rows.map(function (r) {
      return '<div class="meta-row"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('');

    $('bookSubjects').innerHTML = (book.subjects || []).slice(0, 12).map(function (s) {
      return '<span class="subject">' + esc(s) + '</span>';
    }).join('');

    renderDescription(book);
    renderEditions(book);

    var actions = [];
    var dbHref = book.dbUrl || (book.dbId ? 'https://book.douban.com/subject/' + book.dbId + '/' : '');
    if (dbHref) actions.push('<a class="btn-outline" href="' + esc(dbHref) + '" target="_blank" rel="noopener noreferrer">豆瓣书目页</a>');
    if (book.olUrl) actions.push('<a class="btn-outline" href="' + esc(book.olUrl) + '" target="_blank" rel="noopener noreferrer">Open Library 书目页</a>');
    if (book.googleUrl) actions.push('<a class="btn-outline" href="' + esc(book.googleUrl) + '" target="_blank" rel="noopener noreferrer">Google Books 书目页</a>');
    if (book.isbn && book.isbn.length) {
      actions.push('<a class="btn-outline" href="https://openlibrary.org/isbn/' + esc(book.isbn[0]) + '" target="_blank" rel="noopener noreferrer">按 ISBN 查看</a>');
    }
    $('bookActions').innerHTML = actions.join('');

    setCover(book);
  }

  function renderDescription(book) {
    var box = $('bookDesc'), more = $('descMore');
    var desc = plain(book.description);

    if (!desc) {
      box.classList.remove('is-clamped');
      box.innerHTML = '<span class="muted">暂无简介。可点击下方书目页链接前往数据源查看更完整的信息。</span>';
      more.hidden = true;
      return;
    }
    box.textContent = desc;
    if (desc.length > CFG.descClamp) {
      box.classList.add('is-clamped');
      more.hidden = false;
      $('descMoreBtn').textContent = '展开全文（共 ' + desc.length + ' 字）';
    } else {
      box.classList.remove('is-clamped');
      more.hidden = true;
    }
  }

  function renderEditions(book) {
    var others = state.items.filter(function (x) {
      return x.key !== book.key && (normTitle(x.title) === normTitle(book.title) ||
        (x.authors[0] && book.authors[0] && x.authors[0] === book.authors[0]));
    }).slice(0, 5);

    if (!others.length) { $('editionsBlock').hidden = true; $('editionList').innerHTML = ''; return; }
    $('editionsBlock').hidden = false;
    $('editionList').innerHTML = others.map(function (x) {
      var info = [x.authors.join('、'), x.year, (x.publishers || [])[0]].filter(Boolean).join(' · ');
      return '<li>' + esc(x.title) + (info ? ' <span class="muted">— ' + esc(info) + '</span>' : '') +
        ' <button type="button" class="link-btn" data-key="' + esc(x.key) + '">查看</button></li>';
    }).join('');
  }

  function selectBook(book, silent) {
    state.activeKey = state.items.indexOf(book);
    markActive();
    renderDetail(book);
    if (!silent && window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (!book.description) {
      loadDetail(book).then(function (full) {
        if (state.items[state.activeKey] === full) renderDescription(full);
      });
    }
  }

  /* ---------------- 默认封面 ---------------- */

  var COVER_SVG =
    '<svg viewBox="0 0 48 68" width="42" height="58" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3.5" y="2.5" width="41" height="63"></rect>' +
    '<path d="M11 2.5v63"></path>' +
    '<path d="M18 18h20M18 27h20M18 36h13"></path></svg>';

  /* ---------------- 首屏：随机三本推荐 + 谚语 ---------------- */

  /* 谚语：一条一句，出处均取可考的经典原文 */
  var QUOTES = [
    ['书山有路勤为径，学海无涯苦作舟。', '《增广贤文》'],
    ['读书破万卷，下笔如有神。', '杜甫《奉赠韦左丞丈二十二韵》'],
    ['腹有诗书气自华。', '苏轼《和董传留别》'],
    ['书犹药也，善读之可以医愚。', '刘向《说苑》'],
    ['旧书不厌百回读，熟读深思子自知。', '苏轼《送安惇秀才失解西归》'],
    ['少壮不努力，老大徒伤悲。', '汉乐府《长歌行》'],
    ['问渠那得清如许？为有源头活水来。', '朱熹《观书有感》'],
    ['读书之法，在循序而渐进，熟读而精思。', '朱熹《朱子读书法》'],
    ['立身以立学为先，立学以读书为本。', '欧阳修'],
    ['黑发不知勤学早，白首方悔读书迟。', '颜真卿《劝学》'],
    ['书卷多情似故人，晨昏忧乐每相亲。', '于谦《观书》'],
    ['读书不觉已春深，一寸光阴一寸金。', '王贞白《白鹿洞二首》'],
    ['一日不读书，胸臆无佳想。', '萧抡谓《读书有所见作》'],
    ['书籍是人类进步的阶梯。', '高尔基《论文学》'],
    ['读书在于造就完全的人格。', '培根《论读书》']
  ];

  function pickQuote() {
    var q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    $('quoteText').textContent = '“' + q[0] + '”';
    $('quoteFrom').textContent = '—— ' + q[1];
  }

  function recoCardHtml(b) {
    var cover = b.coverSmall || b.coverUrl;
    var img = cover
      ? '<img src="' + esc(coverSrc(cover)) + '" alt="《' + esc(b.title) + '》封面" loading="lazy" referrerpolicy="no-referrer"' +
        ' onerror="this.onerror=null;this.style.display=\'none\';">'
      : COVER_SVG;
    return '<li><button type="button" class="reco-card" data-title="' + esc(b.title) + '">' +
      '<span class="reco-cover' + (cover ? '' : ' is-empty') + '">' + img + '</span>' +
      '<span class="reco-book">' + esc(b.title) + '</span>' +
      '<span class="reco-author">' + esc((b.authors || []).join('、') || '佚名') + '</span>' +
      '</button></li>';
  }

  function loadRecommend() {
    var grid = $('recoGrid');
    var warn = $('imgHint');
    if (warn) warn.hidden = state.backend && state.douban;
    if (state.backend && !state.douban) {
      grid.innerHTML = '<li class="reco-empty">' + PLACEHOLDER_EMPTY + '</li>';
      pickQuote();
      return;
    }
    grid.innerHTML = '<li class="reco-empty">正在挑选今日的书……</li>';

    // 后端不可用时的兜底：直接从豆瓣检索三本
    var jobs = state.backend
      ? [requestJSON('/api/recommend?n=3', { timeout: 20000 })]
      : ['红楼梦', '活着', '三体'].map(function (t) {
          return searchDoubanDirect(t).then(function (list) { return { items: list.slice(0, 1) }; });
        });

    Promise.allSettled(jobs).then(function (rs) {
      var items = [];
      rs.forEach(function (r) {
        if (r.status === 'fulfilled' && r.value && r.value.items) items = items.concat(r.value.items);
      });
      items = items.filter(function (b) { return b && b.title; }).slice(0, 3);

      if (!items.length) {
        grid.innerHTML = '<li class="reco-empty">暂时取不到推荐书目（请确认本地服务与代理已开启），可用上方搜索栏直接查询。</li>';
        return;
      }
      grid.innerHTML = items.map(recoCardHtml).join('');
      pickQuote();
    });

    pickQuote();
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $('searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('searchInput').value;
      if (!plain(q)) { $('searchInput').focus(); return; }
      if (plain(q) === state.query && state.items.length && state.mode === 'search') return;
      search(q, 'search');
    });

    $('resultList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.result-item') : null;
      if (!btn) return;
      var book = state.items[Number(btn.dataset.i)];
      if (book) selectBook(book);
    });

    $('editionList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-key]') : null;
      if (!btn) return;
      var book = state.items.filter(function (x) { return x.key === btn.dataset.key; })[0];
      if (book) selectBook(book);
    });

    $('toggleResults').addEventListener('click', function () {
      state.collapsed = !state.collapsed;
      renderResults();
    });

    $('descMoreBtn').addEventListener('click', function () {
      var clamped = $('bookDesc').classList.toggle('is-clamped');
      this.textContent = clamped ? '展开全文' : '收起';
    });

    $('retryBtn').addEventListener('click', function () {
      if (state.query) { state.loading = false; search(state.query, 'search'); }
    });

    ['optLocal', 'optGlobal'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (!$('optLocal').checked && !$('optGlobal').checked) { this.checked = true; }
        if (state.query && !state.loading) search(state.query, state.mode);
      });
    });

    // 首屏推荐词
    var chips = document.createElement('div');
    chips.className = 'chips';
    chips.innerHTML = RECOMMEND.map(function (q, i) {
      return '<button type="button" class="chip" data-rec="' + i + '">' + esc(q) + '</button>';
    }).join('');
    var anchor = $('stateWelcome').querySelector('.state-text');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chips, anchor.nextSibling);
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-rec]') : null;
      if (!btn) return;
      var q = RECOMMEND[Number(btn.dataset.rec)];
      $('searchInput').value = q;
      search(q, 'search');
    });

    // 随机推荐：换一批 / 点封面查询
    $('recoRefresh').addEventListener('click', function () {
      if (state.loading) return;
      loadRecommend();
    });

    $('recoGrid').addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.reco-card') : null;
      if (!card) return;
      var title = card.dataset.title;
      if (!title) return;
      $('searchInput').value = title;
      search(title, 'search');
    });

    var onScroll = function () {
      if (!document.body) return;
      document.body.classList.toggle('compact', window.scrollY > 60);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== $('searchInput')) {
        e.preventDefault();
        $('searchInput').focus();
      }
    });

    // 探测后端
    detectBackend().then(function () {
      renderStatus();
      var warn = $('imgHint');
      if (warn) {
        warn.hidden = !(state.backend && state.douban);
        if (!warn.hidden) warn.textContent = '书库数据与封面均经本地服务转发，首次检索约需 5～15 秒。';
      }
      loadRecommend();
    });
  }

  window.XunWanJuan = {
    search: function (q) { $('searchInput').value = q; search(q, 'search'); },
    state: state,
    config: CFG
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
