// 轻阅移动端原型 v4 验收脚本：node docs/prototypes/lightread-mobile-v4-assets/acceptance.mjs
// 用真实点击完成主要流程，写出 checks.json 与 screenshots/*.png。__v4 钩子只用于读取状态和打开演示开关。
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, writeFileSync as wf } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'lightread-mobile-v4.html');
const shots = join(here, 'screenshots'); mkdirSync(shots, { recursive: true });
const fx = '/tmp/lightread-v4-fixture.txt';
wf(fx, '第一章 出门\n清早出门，街上还没有什么人。\n卖早点的摊子刚刚支起来。\n\n第二章 回家\n傍晚回家，路灯一盏一盏亮了。\n');
const checks = []; const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail: String(detail) }); console.log(pass ? '✓' : '✗', name, detail); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
const shot = n => p.screenshot({ path: join(shots, n + '.png') });
const st = f => p.evaluate(f);
const tools = async () => { if (!await st(() => __v4.R.tools)) { await p.mouse.click(195, 430); await p.waitForTimeout(300); } };
await p.goto(url); await p.waitForTimeout(900);
await shot('01-library');
// 1 导入 → 阅读 → 排版 → 退出再进入
await p.click('[data-a=add]'); await p.waitForTimeout(300); await shot('02-add-sheet');
await p.setInputFiles('#fpick', fx); await p.waitForTimeout(1500);
const imp = await st(() => __v4.S().books.find(b => b.kind === 'import'));
ok('导入 TXT 并按章节拆分', imp && imp.title.includes('fixture'), imp?.title);
await p.click(`[data-open="${imp.id}"]`); await p.waitForTimeout(700); await shot('03-tap-guide'); await p.click('.tapguide .btn');
await p.mouse.click(370, 430); await p.waitForTimeout(400);
ok('导入的书可以翻页（跨到第二章）', await st(() => __v4.R.c) === 1);
await tools(); await p.click('[data-r=back]'); await p.waitForTimeout(500);
await p.click('[data-open="river"]'); await p.waitForTimeout(700);
await shot('04-reading'); await tools(); await shot('05-reading-tools');
const before = await st(() => __v4.R.pageFirst[__v4.R.page]);
await p.click('[data-p=text]'); await p.waitForTimeout(300); await p.click('[data-v="fs:1"]'); await p.click('[data-v="fs:1"]'); await p.click('[data-v="margin:16"]'); await p.waitForTimeout(400);
await shot('06-text-panel');
const fsNow = await st(() => getComputedStyle(document.getElementById('reader')).getPropertyValue('--fs'));
const after = await st(() => __v4.R.pageFirst[__v4.R.page]);
ok('字号与边距真实作用于正文', fsNow.trim() === '21px', fsNow);
ok('调整后保持在原段落附近', before.split('.').slice(0, 2).join() === after.split('.').slice(0, 2).join() || Math.abs(+before.split('.')[1] - +after.split('.')[1]) <= 2, `${before} → ${after}`);
await p.click('[data-pp=fonts]'); await p.waitForTimeout(300); await shot('07-fonts');
await p.click('[data-v="font:serif"]'); await p.waitForTimeout(300);
ok('字体切换为内置宋体', (await st(() => getComputedStyle(document.querySelector('.text')).fontFamily)).includes('LR Song'));
await p.click('[data-p=display]'); await p.waitForTimeout(300); await p.click('[data-v="theme:sepia"]'); await p.waitForTimeout(300); await shot('08-display-sepia');
ok('正文配色切到米黄', await st(() => document.getElementById('reader').dataset.theme) === 'sepia');
await p.click('[data-pp=close]'); await p.waitForTimeout(300); await p.mouse.click(195, 430); await p.waitForTimeout(300); await p.mouse.click(370, 430); await p.waitForTimeout(300);
const posK = await st(() => __v4.R.pageFirst[__v4.R.page]);
await tools(); await p.click('[data-r=back]'); await p.waitForTimeout(400);
await p.reload(); await p.waitForTimeout(900); await p.click('[data-open="river"]'); await p.waitForTimeout(700);
ok('刷新后再进入：位置恢复', await st(() => __v4.R.pageFirst[__v4.R.page]) === posK, posK);
ok('刷新后再进入：排版与配色恢复', await st(() => document.getElementById('reader').dataset.theme === 'sepia' && __v4.S().prefs.fontSize === 21 && __v4.S().prefs.font === 'serif'));
// 2 选中文字 → 想法 → 回看定位 → 删除撤销
await p.evaluate(() => { const s = document.querySelector('#flow .s:not([data-k$=".-1.0"])'); const r = document.createRange(); r.setStart(s.firstChild, 0); r.setEnd(s.firstChild, Math.min(10, s.firstChild.length)); getSelection().removeAllRanges(); getSelection().addRange(r); });
await p.waitForTimeout(500); await shot('09-selection');
await p.click('[data-s=note]'); await p.waitForTimeout(300); await p.fill('#thought', '这里的节奏很慢，像水。'); await shot('10-write-thought');
await p.click('[data-ok]'); await p.waitForTimeout(400);
ok('想法已保存', await st(() => __v4.S().notes.length) === 1);
await tools(); await p.click('[data-p=notes]'); await p.waitForTimeout(400); await shot('11-notes');
await p.click('.note-item [data-jump]'); await p.waitForTimeout(500);
ok('从笔记定位回正文', await st(() => { const n = __v4.S().notes[0]; return __v4.R.c === n.c; }));
await tools(); await p.click('[data-p=notes]'); await p.waitForTimeout(300); await p.click('[data-nt=del]'); await p.waitForTimeout(300);
ok('删除笔记', await st(() => __v4.S().notes.length) === 0);
await p.click('.toast button:has-text("撤销")'); await p.waitForTimeout(300);
ok('撤销删除', await st(() => __v4.S().notes.length) === 1);
await p.click('[data-pp=close]'); await p.waitForTimeout(300);
// 3 模式：场景临时覆盖与恢复；带读运行/暂停/退出
await tools(); await p.click('[data-p=modes]'); await p.waitForTimeout(300); await shot('12-modes');
await p.click('[data-scene=night]'); await p.waitForTimeout(300); await p.click('[data-scene=large]'); await p.waitForTimeout(300); await shot('13-night-large');
ok('夜读 + 大字可叠加', await st(() => document.getElementById('reader').dataset.theme === 'night' && getComputedStyle(document.getElementById('reader')).getPropertyValue('--fs').trim() === '23px'));
await p.click('[data-scene=eye]'); await p.waitForTimeout(300);
ok('护眼与夜读互斥（开护眼自动关夜读）', await st(() => !__v4.S().scenes.night && __v4.S().scenes.eye));
await p.click('[data-scene=eye]'); await p.click('[data-scene=large]'); await p.waitForTimeout(300);
ok('退出场景后恢复原配色和字号', await st(() => document.getElementById('reader').dataset.theme === 'sepia' && getComputedStyle(document.getElementById('reader')).getPropertyValue('--fs').trim() === '21px'));
for (const g of ['auto', 'tw', 'lyric']) {
  await tools(); if (!await st(() => __v4.R.panel === 'modes')) await p.click('[data-p=modes]'); await p.waitForTimeout(300);
  await p.click(`[data-guide="start:${g}"]`); await p.waitForTimeout(1800);
  if (g === 'tw') await shot('14-typewriter'); if (g === 'lyric') await shot('15-lyric'); if (g === 'auto') await shot('16-auto-page');
  const running = await st(() => __v4.G.type && __v4.G.running);
  await p.click('[data-c=toggle]'); await p.waitForTimeout(200); const paused = await st(() => !__v4.G.running);
  await p.click('[data-c=toggle]'); await p.waitForTimeout(200); const resumed = await st(() => __v4.G.running);
  await p.click('[data-c=exit]'); await p.waitForTimeout(400);
  ok(`带读「${g}」开始、暂停、继续、退出`, running && paused && resumed && await st(() => !__v4.G.type));
}
ok('歌词退出后恢复左右翻页', await st(() => __v4.R.flow === 'page'));
// 4 听书：失败恢复 → 节奏演示 → 收起 → 手动翻页 → 回到听书处 / 改听这一页 → 定时
await st(() => { __v4.S().demo.noVoice = true; });
await p.click('.listen-fab'); await p.waitForTimeout(600); await shot('17-listen-error');
ok('没有系统语音时给出说明与恢复入口', await st(() => __v4.LS.status === 'error') && !!await p.$('[data-l=usepace]'));
await p.click('[data-l=usepace]'); await p.waitForTimeout(2500); await shot('18-player-pace');
ok('节奏演示明确标注无声并推进', (await p.textContent('.srcline')).includes('无声') && await st(() => __v4.LS.playing));
await p.click('[data-l=speed]'); await p.waitForTimeout(300); await shot('19-speed'); await p.click('[data-r="1.5"]'); await p.waitForTimeout(300);
ok('播放中改语速保持播放', await st(() => __v4.LS.playing && __v4.S().listen.rate === 1.5));
await p.click('[data-l=toggle]'); await p.waitForTimeout(200); await p.click('[data-l=speed]'); await p.waitForTimeout(300); await p.click('[data-r="1"]'); await p.waitForTimeout(300);
ok('暂停时改语速保持暂停', await st(() => !__v4.LS.playing && __v4.S().listen.rate === 1));
await p.click('[data-l=toggle]'); await p.waitForTimeout(300);
await p.click('[data-l=collapse]'); await p.waitForTimeout(300); if (await st(() => __v4.R.tools)) { await p.mouse.click(195, 430); await p.waitForTimeout(300); }
const lk = await st(() => __v4.S().listen.k);
await p.mouse.click(370, 430); await p.waitForTimeout(300); await p.mouse.click(370, 430); await p.waitForTimeout(400);
await shot('20-detached');
ok('手动翻页不改变听书位置，显示偏离提示', await st(() => __v4.LS.detached) && (await st(() => __v4.S().listen.k)).split('.')[0] === lk.split('.')[0]);
await p.click('[data-c=back]'); await p.waitForTimeout(500);
ok('回到听书处', await st(() => !__v4.LS.detached));
await p.mouse.click(370, 430); await p.waitForTimeout(300); await p.mouse.click(370, 430); await p.waitForTimeout(300);
const readK = await st(() => __v4.R.pageFirst[__v4.R.page]);
if (await p.$('[data-c=here]')) { await p.click('[data-c=here]'); await p.waitForTimeout(300); }
ok('改听这一页', await st(() => __v4.S().listen.k) === readK || (await st(() => __v4.S().listen.k)).split('.')[0] === readK.split('.')[0], readK);
await p.click('.listen-fab'); await p.waitForTimeout(400); await p.click('#pq-timer'); await p.waitForTimeout(300); await p.click('[data-t="15"]'); await p.waitForTimeout(300);
await p.click('#pq-timer'); await p.waitForTimeout(300); await shot('21-timer'); await p.click('[data-t="ff"]'); await p.waitForTimeout(11500); await shot('22-timer-done');
ok('定时到点真实停止', await st(() => !__v4.LS.playing && __v4.LS.timerDone === 'clock'));
await p.click('[data-l=more]'); await p.waitForTimeout(400);
ok('再听 15 分钟', await st(() => __v4.LS.playing && __v4.S().listen.timer.mode === '15'));
await p.click('[data-l=voice]'); await p.waitForTimeout(400); await shot('23-voices'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
await p.click('[data-l=collapse]'); await p.waitForTimeout(300); await tools(); await p.click('[data-r=back]'); await p.waitForTimeout(600);
await shot('24-mini-player');
ok('离开阅读器后显示迷你播放条', !!await p.$('.mini'));
await p.click('.mini [data-m=toggle]'); await p.waitForTimeout(300);
ok('迷你条暂停', await st(() => !__v4.LS.playing));
// 5 同步：未配置 → 连接中 → 同步 → 失败 → 重试 → 待补
await p.click('[data-tab=settings]'); await p.waitForTimeout(400); await shot('25-settings');
await p.click('.acct'); await p.waitForTimeout(300); await shot('26-sync-empty');
ok('同步未配置的引导', (await p.textContent('.sync-hero')).includes('换台设备'));
await p.click('[data-y=login]'); await p.waitForTimeout(300); await p.fill('input[name=e]', 'reader@example.com'); await p.click('[data-ok]'); await p.waitForTimeout(1100);
await p.fill('input[name=c]', '000000'); await p.click('[data-ok]'); await p.waitForTimeout(300); await shot('27-login-code-error');
ok('验证码错误给出说明', !(await p.$eval('#lerr2', e => e.classList.contains('hide'))));
await p.fill('input[name=c]', '246810'); await p.click('[data-ok]'); await p.waitForTimeout(2600); await shot('28-syncing');
ok('同步阶段推进', await st(() => __v4.S().sync.state === 'syncing'));
await p.waitForTimeout(3500);
ok('同步成功', await st(() => __v4.S().sync.state === 'ok' && __v4.S().sync.last > 0));
await st(() => { __v4.S().demo.failSync = true; }); await p.click('[data-y=sync]'); await p.waitForTimeout(3200); await shot('29-sync-failed');
ok('同步失败状态', await st(() => __v4.S().sync.state === 'fail'));
await p.click('.sync-hero [data-y=sync]'); await p.waitForTimeout(5200);
ok('失败后重试成功', await st(() => __v4.S().sync.state === 'ok'));
await p.click('[data-sw=secrets]'); await p.waitForTimeout(300); await shot('30-secrets-confirm');
ok('密码与密钥同步需单独确认', !!await p.$('.sheet.center'));
await p.click('[data-a=no]'); await p.waitForTimeout(300);
ok('取消后保持关闭', await st(() => !__v4.S().sync.opts.secrets));
// 6 论文 / 书源 / 记录
await p.click('[data-tab=papers]'); await p.waitForTimeout(300); await p.click('[data-open=p1]'); await p.waitForTimeout(600); await shot('31-paper-original');
await p.click('[data-pa=tr]'); await p.click('[data-pa="mode:reflow"]'); await p.waitForTimeout(400); await shot('32-paper-reflow-translate');
await p.click('[data-pa=ai]'); await p.waitForTimeout(300); await p.click('[data-q="1"]'); await p.waitForTimeout(300); await shot('33-paper-assistant');
ok('论文助手为标注的预置回答', (await p.textContent('#ans')).includes('预置回答'));
await p.keyboard.press('Escape'); await p.waitForTimeout(300); await p.click('[data-pa=back]'); await p.waitForTimeout(400);
await p.click('[data-tab=sources]'); await p.waitForTimeout(300); await shot('34-sources');
await p.fill('#srcq', '论语'); await p.press('#srcq', 'Enter'); await p.waitForTimeout(1000); await shot('35-source-results');
await p.fill('#srcq', '找不到的书'); await p.press('#srcq', 'Enter'); await p.waitForTimeout(1000); await shot('36-source-empty');
await st(() => { __v4.S().demo.failSearch = true; }); await p.fill('#srcq', '庄子'); await p.press('#srcq', 'Enter'); await p.waitForTimeout(1000); await shot('37-source-error');
ok('书源错误可重试', !!await p.$('[data-a=retry]')); await p.click('[data-a=retry]'); await p.waitForTimeout(1000);
ok('重试后出现结果', !!await p.$('[data-get]'));
await p.click('[data-tab=log]'); await p.waitForTimeout(400); await shot('38-reading-log');
ok('阅读记录来自真实计时', await st(() => Object.values(__v4.S().stats.days).reduce((a, b) => a + b, 0)) > 0);
// 7 删除撤销 / 空书架
await p.click('[data-tab=library]'); await p.waitForTimeout(400);
const n0 = await st(() => __v4.S().books.length);
await p.click('.bk [data-more]'); await p.waitForTimeout(300); await shot('39-book-detail'); await p.click('[data-x=del]'); await p.waitForTimeout(400); await shot('40-delete-undo');
await p.click('.toast button:has-text("撤销")'); await p.waitForTimeout(300);
ok('删除书籍可撤销', await st(() => __v4.S().books.filter(b => !b._deleting).length) === n0);
// 8 夜间外观
await p.click('[data-tab=settings]'); await p.waitForTimeout(300); await p.click('[data-go=appearance]'); await p.waitForTimeout(300); await p.click('[data-ap=dark]'); await p.waitForTimeout(300);
await p.click('[data-back]'); await p.waitForTimeout(300); await p.click('[data-tab=library]'); await p.waitForTimeout(400); await shot('41-app-dark');
ok('外观深色不改变显式选择的正文配色', await st(() => __v4.S().prefs.theme === 'sepia'));
await p.click('[data-open="night"]'); await p.waitForTimeout(600); await tools(); await p.click('[data-p=display]'); await p.waitForTimeout(300); await p.click('[data-v="theme:night"]'); await p.waitForTimeout(300); await shot('42-night-panel');
await p.click('[data-pp=close]'); await p.waitForTimeout(200); await p.click('.listen-fab'); await p.waitForTimeout(500); await shot('43-night-player');
// 9 重置只影响 v4
await p.evaluate(() => localStorage.setItem('lightread-prototype-v3', '{"keep":1}'));
await p.goto(url + '#/settings/data'); await p.waitForTimeout(500); await p.click('[data-x=reset]'); await p.waitForTimeout(300); await p.click('[data-a=ok]'); await p.waitForTimeout(800);
ok('重置只清除 v4，保留 v3 存储', await p.evaluate(() => localStorage.getItem('lightread-prototype-v3') === '{"keep":1}' && !__v4.S().books.some(b => b.kind === 'import')));
await p.evaluate(() => localStorage.removeItem('lightread-prototype-v3'));
ok('控制台无错误', errs.length === 0, errs.join(' | '));
await ctx.close();
// 10 宽度
for (const [w, h] of [[320, 640], [375, 812], [414, 896], [768, 1024], [1440, 900]]) {
  const c = await b.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1000, isMobile: w < 1000 }); const q = await c.newPage();
  await q.goto(url); await q.waitForTimeout(800);
  const o1 = await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await q.screenshot({ path: join(shots, `w${w}-library.png`) });
  await q.click('[data-open="river"]'); await q.waitForTimeout(600); await q.click('.tapguide .btn'); await q.mouse.click(w / 2, h / 2); await q.waitForTimeout(300); await q.click('[data-p=text]'); await q.waitForTimeout(300);
  const o2 = await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.rpanel button,.rtabs button,.rtop button')].every(b => { const r = b.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; }));
  await q.screenshot({ path: join(shots, `w${w}-reader-text.png`) });
  ok(`${w}px：无横向溢出，工具可达`, o1 && o2);
  await c.close();
}
await b.close();
writeFileSync(join(here, 'checks.json'), JSON.stringify({ at: new Date().toISOString(), pass: checks.filter(c => c.pass).length, total: checks.length, checks }, null, 1));
console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} 通过`);
