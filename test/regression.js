const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'yooc-autoplay.user.js'), 'utf8');

// 测试用加速配置：逻辑不变，只压缩各段等待时间
const SCRIPT = RAW
  .replace('nextDelayMs: 5000', 'nextDelayMs: 300')
  .replace('pageSettleMs: 2500', 'pageSettleMs: 200')
  .replace('handoffMs: 7000', 'handoffMs: 1200')
  .replace('readyTimeoutMs: 90000', 'readyTimeoutMs: 3000')
  .replace('noVideoWaitMs: 15000', 'noVideoWaitMs: 3000');

const BASE = 'https://xueyuan.yooc.me/courses/YOOC/CC1234/2026/courseware/55';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeVideo(doc, startSrc, opts) {
  const o = opts || {};
  const v = doc.createElement('video');
  doc.body.appendChild(v);
  const s = {
    currentTime: 0, duration: 300, src: startSrc, playing: false,
    readyState: o.readyState == null ? 4 : o.readyState, playCount: 0
  };
  Object.defineProperty(v, 'duration', { get: () => s.duration, configurable: true });
  Object.defineProperty(v, 'currentTime', { get: () => s.currentTime, set: (x) => { s.currentTime = x; }, configurable: true });
  Object.defineProperty(v, 'currentSrc', { get: () => s.src, configurable: true });
  Object.defineProperty(v, 'src', { get: () => s.src, configurable: true });
  Object.defineProperty(v, 'paused', { get: () => !s.playing, configurable: true });
  Object.defineProperty(v, 'ended', { get: () => s.duration > 0 && s.currentTime >= s.duration, configurable: true });
  Object.defineProperty(v, 'seeking', { get: () => false, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => s.readyState, set: (x) => { s.readyState = x; }, configurable: true });
  v.play = () => { s.playing = true; s.playCount++; return Promise.resolve(); };
  v.pause = () => { s.playing = false; };
  return { v, s };
}

function catalogHtml(n, clsFn) {
  const lis = [];
  for (let i = 1; i <= n; i++) {
    lis.push(`<li class="${clsFn ? clsFn(i) : 'item'}"><a href="${BASE}/${i}">第${i}节</a></li>`);
  }
  return `<!doctype html><html><body><ul class="chapter-list">${lis.join('')}</ul></body></html>`;
}

const results = [];

/* A. inactive 类不得误导定位 */
async function caseA() {
  const html = catalogHtml(6, (i) => i === 1 ? 'chapter-item inactive' : (i === 3 ? 'chapter-item active' : 'chapter-item'));
  const dom = new JSDOM(html, { url: BASE, runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = dom.window.document;
  const { s } = makeVideo(doc, BASE + '/3', { readyState: 4 });

  const clicked = [];
  doc.querySelectorAll('.chapter-list a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      clicked.push(Number(a.getAttribute('href').split('/').pop()));
      s.src = a.getAttribute('href');
      s.currentTime = 0; s.playing = false; s.duration = 300;
      doc.querySelectorAll('.chapter-item').forEach((li) => li.classList.remove('active'));
      a.closest('li').classList.add('active');
    });
  });

  dom.window.eval(SCRIPT);
  await sleep(300);
  doc.getElementById('ybap-panel').querySelector('[data-a="toggle"]').click();
  await sleep(600);

  for (let k = 0; k < 8; k++) { s.currentTime = s.duration - 0.1; await sleep(700); }

  let mono = true;
  for (let i = 1; i < clicked.length; i++) if (clicked[i] <= clicked[i - 1]) mono = false;

  results.push({
    name: 'A. inactive 不误导定位（真实 bug）',
    pass: mono && clicked.length >= 2,
    detail: '序列 [' + clicked.join(',') + ']'
  });
  dom.window.close();
}

/* B. 重载后按 href 锚点续播 */
async function caseB() {
  const html = catalogHtml(6);
  const run1 = new JSDOM(html, { url: BASE + '/2', runScripts: 'outside-only', pretendToBeVisual: true });
  const d1 = run1.window.document;
  const m1 = makeVideo(d1, BASE + '/2', { readyState: 4 });
  d1.querySelectorAll('.chapter-list a').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); });
  });
  run1.window.eval(SCRIPT);
  await sleep(300);
  d1.getElementById('ybap-panel').querySelector('[data-a="toggle"]').click();
  await sleep(600);
  m1.s.currentTime = 299.9;
  await sleep(2500);
  const saved = run1.window.sessionStorage.getItem('ybap.p');
  run1.window.close();

  const dom2 = new JSDOM(html, { url: BASE + '/2?from=list', runScripts: 'outside-only', pretendToBeVisual: true });
  dom2.window.sessionStorage.setItem('ybap.p', saved || '{}');
  dom2.window.localStorage.setItem('ybap.on.v1', '1');
  const d2 = dom2.window.document;
  const m2 = makeVideo(d2, BASE + '/3', { readyState: 4 });
  const clicked2 = [];
  d2.querySelectorAll('.chapter-list a').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); clicked2.push(Number(a.getAttribute('href').split('/').pop())); });
  });

  dom2.window.eval(SCRIPT);
  await sleep(500);
  m2.s.currentTime = 299.9;
  await sleep(2500);

  results.push({
    name: 'B. 重载后按 href 锚点续播（应点第 4 节）',
    pass: clicked2[0] === 4,
    detail: '首点 ' + (clicked2[0] || '(无)')
  });
  dom2.window.close();
}

/* C. 顶层含 iframe 时不得误判无视频 */
async function caseC() {
  const html = catalogHtml(3) + '';
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <ul class="chapter-list">${[1,2,3].map(i => `<li class="item"><a href="${BASE}/${i}">第${i}节</a></li>`).join('')}</ul>
      <iframe src="about:blank"></iframe>
    </body></html>`,
    { url: BASE + '/1', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const doc = dom.window.document;
  const clicked = [];
  doc.querySelectorAll('.chapter-list a').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); clicked.push(a.getAttribute('href')); });
  });

  dom.window.eval(SCRIPT);
  await sleep(300);
  doc.getElementById('ybap-panel').querySelector('[data-a="toggle"]').click();
  await sleep(6000); // noVideoWaitMs 已压到 3s，旧版会在此误跳

  results.push({
    name: 'C. 顶层含 iframe 时不误跳',
    pass: clicked.length === 0,
    detail: '点击次数 ' + clicked.length
  });
  dom.window.close();
}

/* D. 视频未就绪不播放，就绪后才播 */
async function caseD() {
  const html = catalogHtml(3);
  const dom = new JSDOM(html, { url: BASE + '/1', runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = dom.window.document;
  const { s } = makeVideo(doc, BASE + '/1', { readyState: 0 }); // 尚未加载
  s.duration = NaN;

  dom.window.eval(SCRIPT);
  await sleep(300);
  doc.getElementById('ybap-panel').querySelector('[data-a="toggle"]').click();
  await sleep(2000);

  const beforeReady = s.playCount;

  // 模拟加载完成
  s.readyState = 4;
  s.duration = 300;
  await sleep(2000);
  const afterReady = s.playCount;

  results.push({
    name: 'D. 未就绪不播，就绪后才播',
    pass: beforeReady === 0 && afterReady >= 1,
    detail: '就绪前 play=' + beforeReady + '，就绪后 play=' + afterReady
  });
  dom.window.close();
}

(async () => {
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  console.log('');
  results.forEach((r) => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name.padEnd(34) + ' [' + r.detail + ']'));
  process.exit(results.every((r) => r.pass) ? 0 : 2);
})();
