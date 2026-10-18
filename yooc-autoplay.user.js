// ==UserScript==
// @name         易班优课 · 课群课程自动连播
// @namespace    https://github.com/horatsu/yooc-autoplay
// @version      1.0.0
// @description  课群课程学习页：按目录顺序自动完整播放视频，一节播完自动进入下一节，本页目录全部播完即停止。只做界面自动化，不跳进度、不伪造学习记录。
// @author       Wu Shang (horatsu)
// @homepageURL  https://github.com/horatsu/yooc-autoplay
// @supportURL   https://github.com/horatsu/yooc-autoplay/issues
// @updateURL    https://raw.githubusercontent.com/horatsu/yooc-autoplay/main/yooc-autoplay.user.js
// @downloadURL  https://raw.githubusercontent.com/horatsu/yooc-autoplay/main/yooc-autoplay.user.js
// @license      MIT
// @match        *://*.yooc.me/*
// @match        *://yooc.me/*
// @match        *://*.yiban.cn/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__ybapLoaded) return;
  window.__ybapLoaded = true;

  /* ============================ 配置 ============================ */

  var CFG = {
    rate: 1,             // 播放倍速（1 = 原速，改这个会影响平台记录的实际时长）
    endSlack: 0.6,       // 距结尾多少秒算播完
    minDuration: 4,      // 短于该秒数的视频不当作一节课（过滤片头/广告）
    scanMs: 900,         // 巡检间隔
    noVideoWaitMs: 15000,// 页面无视频超过该时长则跳过本项（图文课件）
    stallMs: 8000,       // 暂停/卡住多久后尝试恢复
    nextDelayMs: 1500,   // 本节播完后延迟多久点下一节
    handoffMs: 7000,     // 切节后的冷却时间，防连点
    muteWhenBlocked: true,
    debug: true          // 调试输出，装好后可改 false
  };

  var IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  })();

  function log() {
    if (!CFG.debug) return;
    try {
      var a = [].slice.call(arguments);
      a.unshift('%c[优课连播]', 'color:#25c2a0');
      console.log.apply(console, a);
    } catch (e) {}
  }

  /* ============================ 状态 ============================ */

  var ST = {
    on: false,            // 顶层：连播开关
    items: [],            // 顶层：目录项
    curIdx: -1,
    handoff: false,
    retried: false,
    pendingNext: false,
    finishedKey: null,
    lastTime: 0,
    lastMoveTs: Date.now(),
    lastPlayTry: 0,
    enteredTs: Date.now(),
    lastBroadcast: 0
  };

  var remoteOn = false;   // 内层 iframe：由顶层 START 信号激活

  function active() { return IS_TOP ? ST.on : remoteOn; }

  var LS_KEY = 'ybap.on.v1';
  function saveOn(v) { try { localStorage.setItem(LS_KEY, v ? '1' : '0'); } catch (e) {} }
  function loadOn() { try { return localStorage.getItem(LS_KEY) === '1'; } catch (e) { return false; } }

  function saveIdx(i) { try { sessionStorage.setItem('ybap.idx', String(i)); } catch (e) {} }
  function loadIdx() {
    try {
      var v = sessionStorage.getItem('ybap.idx');
      return v == null ? -1 : parseInt(v, 10);
    } catch (e) { return -1; }
  }

  /* ============================ 视频驱动 ============================ */

  function pickVideo() {
    var vs = document.querySelectorAll('video');
    if (!vs.length) return null;
    var best = null, bestD = -1;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      var d = (v.duration && isFinite(v.duration)) ? v.duration : 0;
      if (d > bestD) { bestD = d; best = v; }
    }
    return best || vs[0];
  }

  function vKey(v) {
    var d = (v.duration && isFinite(v.duration)) ? v.duration.toFixed(1) : 'x';
    var src = v.currentSrc || v.src || '';
    return document.URL + '|' + src + '|' + d;
  }

  function isFinished(v) {
    if (!v) return false;
    if (v.ended) return true;
    var d = v.duration;
    if (!d || !isFinite(d) || d <= 0) return false;
    if (v.seeking) return false;
    return v.currentTime >= d - CFG.endSlack;
  }

  function tryPlay(v) {
    var p;
    try { p = v.play(); } catch (e) { log('play 抛错', e); return; }
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) {
        log('play 被拦截', err && err.name);
        if (CFG.muteWhenBlocked) {
          try {
            v.muted = true;
            var p2 = v.play();
            if (p2 && p2.catch) p2.catch(function (e2) { log('静音后仍失败', e2 && e2.name); });
            log('已降级为静音播放');
          } catch (e3) {}
        }
      });
    }
  }

  function driveVideo(v) {
    var now = Date.now();

    if (CFG.rate > 0 && Math.abs((v.playbackRate || 1) - CFG.rate) > 1e-3) {
      try { v.playbackRate = CFG.rate; } catch (e) {}
    }

    if (v.currentTime !== ST.lastTime) {
      ST.lastTime = v.currentTime;
      ST.lastMoveTs = now;
    }

    if (isFinished(v)) { onFinished(v); return; }

    if (v.paused && !v.ended) {
      if (now - ST.lastMoveTs > CFG.stallMs && now - ST.lastPlayTry > 5000) {
        ST.lastPlayTry = now;
        log('检测到暂停或卡住，尝试恢复播放');
        tryPlay(v);
      }
    }
  }

  function onFinished(v) {
    var d = v.duration;
    if (d && isFinite(d) && d < CFG.minDuration) return; // 片头，不算一节

    var key = vKey(v);
    if (ST.finishedKey === key) return;
    ST.finishedKey = key;
    ST.retried = false;

    log('本节播放完成', key);

    if (IS_TOP) {
      setStatus('本节完成，准备下一节…');
      setTimeout(function () { maybeNext(); }, CFG.nextDelayMs);
    } else {
      try { window.top.postMessage({ __ybap: 1, type: 'END', key: key }, '*'); } catch (e) {}
    }
  }

  /* ============================ 目录解析 ============================ */

  var NAV_SEL = 'header,nav,footer,.header,.navbar,.footer,.topnav,#header,#footer,.breadcrumb,.crumbs,.pagination';

  var SKIP_TEXT = /^(上一[节课]|下一[节课]|上节|下节|上一个|下一个|上一页|下一页|返回|更多|全部)$/;

  function normUrl(u) {
    return String(u).split('#')[0]
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  }

  function itemOf(a) {
    var n = a, depth = 0;
    while (n && n !== document.body && depth < 4) {
      if (n.tagName === 'LI') return n;
      if (typeof n.className === 'string' &&
          /(item|chapter|section|lesson|outline)/i.test(n.className)) return n;
      n = n.parentElement;
      depth++;
    }
    return a;
  }

  function okLink(a, re) {
    if (!a || !a.href) return false;
    if (a.closest('#ybap-panel')) return false;
    if (a.closest(NAV_SEL)) return false;
    var href = a.getAttribute('href') || '';
    if (!href || href === '#' || /^javascript:/i.test(href)) return false;
    if (SKIP_TEXT.test((a.textContent || '').trim())) return false;
    return re.test(a.href);
  }

  function dedupeByEl(list) {
    var set = new Set(), res = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || set.has(list[i])) continue;
      set.add(list[i]);
      res.push(list[i]);
    }
    return res;
  }

  function dedupeByHref(list) {
    var seen = new Set(), res = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var a = el.matches('a[href]') ? el : el.querySelector('a[href]');
      var k = a ? normUrl(a.href) : '#' + i;
      if (seen.has(k)) continue;
      seen.add(k);
      res.push(el);
    }
    return res;
  }

  function byHref(re) {
    var links = document.querySelectorAll('a[href]');
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!okLink(a, re)) continue;
      out.push(itemOf(a));
    }
    return dedupeByHref(dedupeByEl(out));
  }

  function byContainer() {
    var roots = document.querySelectorAll(
      '[class*="chapter"],[class*="catalog"],[class*="outline"],[class*="directory"],' +
      '[class*="course-menu"],[class*="menu-list"],[class*="courselist"],[class*="course-list"]'
    );
    var best = [];
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (r.closest('#ybap-panel')) continue;
      var lis = Array.prototype.filter.call(r.querySelectorAll('li'), function (el) {
        return (el.textContent || '').trim().length > 0;
      });
      if (lis.length > best.length) best = lis;
    }
    if (best.length < 2) {
      for (var j = 0; j < roots.length; j++) {
        var as = roots[j].querySelectorAll('a[href]');
        var buf = [];
        for (var k = 0; k < as.length; k++) {
          if (okLink(as[k], /./)) buf.push(itemOf(as[k]));
        }
        if (buf.length > best.length) best = buf;
      }
    }
    return dedupeByHref(dedupeByEl(best));
  }

  function collectCatalog() {
    var items = byHref(/courseware/i);
    if (items.length >= 2) { log('目录来源: href=courseware', items.length); return items; }
    var single = items.length === 1 ? items : null;

    items = byHref(/chapter|section|lesson|videoplay/i);
    if (items.length >= 2) { log('目录来源: href=chapter', items.length); return items; }
    if (!single && items.length === 1) single = items;

    items = byContainer();
    if (items.length >= 2) { log('目录来源: 容器推断', items.length); return items; }

    // 只有一项：仅当它就是当前正在学习的那一节时才认（支持单节课程）
    if (single && locateCurrent(single) >= 0) {
      log('目录来源: 单节目录');
      return single;
    }

    log('未识别到课程目录');
    return [];
  }

  function ensureItems() {
    if (!ST.items.length) ST.items = collectCatalog();
    return ST.items;
  }

  function locateCurrent(items) {
    if (!items || !items.length) return -1;
    var here = normUrl(location.href);

    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var a = el.matches('a[href]') ? el : el.querySelector('a[href]');
      if (a && normUrl(a.href) === here) return i;
    }

    for (var j = 0; j < items.length; j++) {
      var el2 = items[j];
      if (/(^|\s)(active|current|selected|playing|doing)(\s|$)/i.test(String(el2.className || ''))) return j;
      if (el2.querySelector('[class*="active"],[class*="current"],[class*="selected"],[class*="playing"]')) return j;
    }

    return -1;
  }

  /* ============================ 推进 ============================ */

  function maybeNext() {
    if (!IS_TOP) return;

    // 冷却期内到达的完成信号不能丢，挂起等冷却结束后补执行
    if (ST.handoff) { ST.pendingNext = true; return; }

    var items = ensureItems();
    if (!items.length) {
      setStatus('未找到课程目录，请确认当前在学习页');
      return;
    }

    if (ST.curIdx < 0) ST.curIdx = locateCurrent(items);
    if (ST.curIdx < 0) {
      var saved = loadIdx();
      if (saved >= 0 && saved < items.length) ST.curIdx = saved;
    }

    // 定位失败时保持 -1，即从第 1 节开始（宁可重播，不可漏播）
    var n = ST.curIdx + 1;
    if (n < 0) n = 0;
    if (n >= items.length) { finishAll(); return; }

    ST.handoff = true;
    ST.curIdx = n;
    saveIdx(n);

    var el = items[n];
    var target = el.matches('a[href]') ? el : (el.querySelector('a[href]') || el);

    try { target.scrollIntoView({ block: 'center' }); } catch (e) {}

    setStatus('进入第 ' + (n + 1) + ' / ' + items.length + ' 节');

    var anchorHref = location.href;
    var oldV = pickVideo();
    var oldKey = oldV ? vKey(oldV) : null;

    setTimeout(function () {
      try { target.click(); } catch (e) { log('click 失败', e); }
    }, 300);

    setTimeout(function () {
      ST.handoff = false;
      var v2 = pickVideo();
      var changed = location.href !== anchorHref || (v2 && vKey(v2) !== oldKey);
      if (!changed && !ST.retried) {
        ST.retried = true;
        log('切节未生效，重试一次');
        try { target.click(); } catch (e) {}
      }
      if (ST.pendingNext) {
        ST.pendingNext = false;
        maybeNext();
      }
    }, CFG.handoffMs);
  }

  function finishAll() {
    ST.on = false;
    ST.pendingNext = false;
    ST.handoff = false;
    saveOn(false);
    try { sessionStorage.removeItem('ybap.idx'); } catch (e) {}

    setStatus('本页目录已全部播放完成');
    toast('本页课程目录已全部播放完成，脚本已停止', 8000);
    broadcast('STOP');
    log('全部完成');
  }

  /* ============================ 界面 ============================ */

  var panel = null, statusEl = null, barEl = null, toggleBtn = null;

  var CSS = [
    '#ybap-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:206px;',
    'background:rgba(20,22,28,.93);color:#e6e8ec;border:1px solid rgba(255,255,255,.13);',
    'border-radius:12px;font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'box-shadow:0 10px 30px rgba(0,0,0,.4);backdrop-filter:blur(8px);overflow:hidden;user-select:none}',
    '#ybap-panel .hd{display:flex;align-items:center;gap:6px;padding:9px 11px;cursor:pointer;',
    'border-bottom:1px solid rgba(255,255,255,.08)}',
    '#ybap-panel .dot{width:7px;height:7px;border-radius:50%;background:#6b7280;flex:0 0 auto}',
    '#ybap-panel.run .dot{background:#25c2a0;box-shadow:0 0 0 3px rgba(37,194,160,.18)}',
    '#ybap-panel .tt{flex:1;font-weight:600;font-size:12.5px;letter-spacing:.3px}',
    '#ybap-panel .mini{color:#8b93a1;font-size:14px;line-height:1}',
    '#ybap-panel .bd{padding:10px 11px 11px}',
    '#ybap-panel.fold .bd{display:none}',
    '#ybap-panel .st{color:#b9c0cc;min-height:34px;word-break:break-all}',
    '#ybap-panel .bar{height:3px;border-radius:2px;background:rgba(255,255,255,.1);margin:8px 0 10px;overflow:hidden}',
    '#ybap-panel .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#25c2a0,#4f8ef7);transition:width .3s}',
    '#ybap-panel .row{display:flex;gap:6px}',
    '#ybap-panel button{flex:1;padding:6px 0;border-radius:7px;border:1px solid rgba(255,255,255,.14);',
    'background:rgba(255,255,255,.06);color:#e6e8ec;font-size:12px;cursor:pointer;transition:.15s}',
    '#ybap-panel button:hover{background:rgba(255,255,255,.13)}',
    '#ybap-panel button.pri{background:#25c2a0;border-color:#25c2a0;color:#06231c;font-weight:600}',
    '#ybap-panel button.pri:hover{background:#2ed6b1}',
    '#ybap-panel .rate{margin-top:8px;display:flex;align-items:center;gap:6px;color:#8b93a1}',
    '#ybap-panel select{flex:1;background:rgba(255,255,255,.06);color:#e6e8ec;border:1px solid rgba(255,255,255,.14);',
    'border-radius:6px;padding:3px 5px;font-size:12px;outline:none}',
    '#ybap-toast{position:fixed;right:16px;bottom:186px;z-index:2147483000;max-width:300px;',
    'background:rgba(20,22,28,.95);color:#e6e8ec;border:1px solid rgba(37,194,160,.4);',
    'border-radius:10px;padding:9px 13px;font:12.5px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .3s;pointer-events:none}'
  ].join('');

  function buildPanel() {
    if (!IS_TOP || document.getElementById('ybap-panel')) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'ybap-panel';
    panel.innerHTML =
      '<div class="hd">' +
        '<span class="dot"></span>' +
        '<span class="tt">优课连播</span>' +
        '<span class="mini">—</span>' +
      '</div>' +
      '<div class="bd">' +
        '<div class="st">待机中，点「开始连播」</div>' +
        '<div class="bar"><i></i></div>' +
        '<div class="row">' +
          '<button data-a="toggle" class="pri">开始连播</button>' +
          '<button data-a="skip">跳过本节</button>' +
        '</div>' +
        '<div class="rate">倍速' +
          '<select data-a="rate">' +
            '<option value="1">1.0x</option>' +
            '<option value="1.25">1.25x</option>' +
            '<option value="1.5">1.5x</option>' +
            '<option value="2">2.0x</option>' +
          '</select>' +
        '</div>' +
      '</div>';

    document.documentElement.appendChild(panel);

    statusEl = panel.querySelector('.st');
    barEl = panel.querySelector('.bar i');
    toggleBtn = panel.querySelector('[data-a="toggle"]');

    panel.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-a');

      if (!act && e.target.closest('.hd')) {
        panel.classList.toggle('fold');
        return;
      }
      if (act === 'toggle') {
        ST.on = !ST.on;
        saveOn(ST.on);
        ST.enteredTs = Date.now();
        ST.finishedKey = null;
        ST.handoff = false;
        if (ST.on) {
          ensureItems();
          ST.curIdx = locateCurrent(ST.items);
          saveIdx(ST.curIdx);
          broadcast('START');
          setStatus('已启动，共 ' + ST.items.length + ' 节');
          var v = pickVideo();
          if (v) tryPlay(v);
        } else {
          broadcast('STOP');
          setStatus('已暂停');
        }
        syncBtn();
      }
      if (act === 'skip') {
        ST.finishedKey = null;
        ST.handoff = false;
        ensureItems();
        var i = locateCurrent(ST.items);
        if (i >= 0) ST.curIdx = i;
        maybeNext();
      }
    });

    panel.querySelector('[data-a="rate"]').addEventListener('change', function (e) {
      CFG.rate = parseFloat(e.target.value) || 1;
      log('倍速 →', CFG.rate);
    });

    syncBtn();
  }

  function syncBtn() {
    if (!toggleBtn) return;
    toggleBtn.textContent = ST.on ? '暂停连播' : '开始连播';
    toggleBtn.className = ST.on ? '' : 'pri';
    if (panel) panel.classList.toggle('run', !!ST.on);
  }

  function setStatus(txt) {
    if (statusEl) statusEl.textContent = txt;
  }

  function setBar(pct) {
    if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function toast(msg, ms) {
    if (!IS_TOP) return;
    var el = document.getElementById('ybap-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ybap-toast';
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.style.opacity = '0'; }, ms || 4000);
  }

  function updatePanel() {
    if (!panel) return;
    if (!ST.on) { setBar(0); return; }

    var v = pickVideo();
    var total = ST.items.length;
    var pos = ST.curIdx >= 0 ? (ST.curIdx + 1) : 0;

    if (v && v.duration && isFinite(v.duration)) {
      var pct = (v.currentTime / v.duration) * 100;
      setBar(pct);
      setStatus('第 ' + pos + ' / ' + total + ' 节 · ' + pct.toFixed(0) + '% · ' +
        fmt(v.currentTime) + ' / ' + fmt(v.duration));
    } else {
      setStatus('第 ' + pos + ' / ' + total + ' 节 · 等待播放器');
    }
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* ============================ 跨 frame 通信 ============================ */

  function broadcast(type) {
    if (!IS_TOP) return;
    var fs = window.frames;
    for (var i = 0; i < fs.length; i++) {
      try { fs[i].postMessage({ __ybap: 1, type: type }, '*'); } catch (e) {}
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__ybap !== 1) return;

    if (d.type === 'START') { remoteOn = true; log('收到 START'); }
    else if (d.type === 'STOP') { remoteOn = false; }
    else if (d.type === 'END' && IS_TOP && ST.on) {
      log('内层播放器报告完成');
      setTimeout(function () { maybeNext(); }, CFG.nextDelayMs);
    }
  });

  /* ============================ 主循环 ============================ */

  function loop() {
    var now = Date.now();

    if (IS_TOP) {
      if (ST.on && now - ST.lastBroadcast > 3000) {
        ST.lastBroadcast = now;
        broadcast('START');
      }
      updatePanel();
    }

    if (!active()) return;

    var v = pickVideo();
    if (v) {
      ST.enteredTs = now;
      driveVideo(v);
      return;
    }

    // 本页没有视频：可能是图文/测验课件，等一段时间后跳过
    if (IS_TOP && ST.on) {
      ensureItems();
      if (ST.items.length && now - ST.enteredTs > CFG.noVideoWaitMs) {
        ST.enteredTs = now;
        log('本页无视频，跳过本项');
        setStatus('本页无视频，跳过');
        maybeNext();
      }
    }
  }

  /* ============================ 启动 ============================ */

  if (IS_TOP) {
    buildPanel();
    if (loadOn()) {
      ST.on = true;
      ensureItems();
      ST.curIdx = locateCurrent(ST.items);
      saveIdx(ST.curIdx);
      syncBtn();
      setStatus('恢复上次状态，共 ' + ST.items.length + ' 节');
      broadcast('START');
      log('自动恢复连播，目录项', ST.items.length);
    }
  }

  setInterval(loop, CFG.scanMs);
  setTimeout(loop, 500);

  log(IS_TOP ? '顶层已注入' : '内层已注入', location.href);
})();
