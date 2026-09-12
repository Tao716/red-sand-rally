import '@fontsource-variable/outfit';
import './style.css';
import { gsap } from 'gsap';
import { RaceSimulation } from './simulation';
import { RaceRenderer } from './renderer';
import { GameAudio } from './audio';
import { MUSIC_BPM, MUSIC_TITLE } from './music';
import { GameInput } from './input';
import { RaceFeedbackHUD } from './feedback-hud';
import { icon } from './icons';
import { minimapPath, minimapPoint, TRACK_LENGTH } from './track';
import { DIFFICULTIES, DIFFICULTY_ORDER, isDifficulty } from './difficulty';
import { readSelectedDifficulty, saveSelectedDifficulty, readBestTime, saveBestTime } from './progress';
import { isSkinId, readSelectedSkin, saveSelectedSkin, SKINS } from './skins';
import { paintSkinSwatches, skinPickerMarkup } from './skin-picker';
import type { Difficulty, GamePhase, ItemType, GameEvent } from './types';

const ITEMS: Record<ItemType, { name: string; subtitle: string; description: string; color: string }> = {
  rocket: { name: '追踪火箭', subtitle: 'LOCK ON. LET GO.', description: '追击前车，制造超车窗口。蓄满漂移能量，升级为强力火箭。', color: '#e96337' },
  mine: { name: '感应地雷', subtitle: 'LEAVE A SURPRISE.', description: '在车后布雷，封锁追兵路线。强化后命中范围更大。', color: '#a083c8' },
  shield: { name: '能量护盾', subtitle: 'KEEP YOUR LEAD.', description: '抵御来袭武器，守住领先。强化后获得更长的保护时间。', color: '#54b8a9' },
  nitro: { name: '氮气喷射', subtitle: 'MORE IS MORE.', description: '瞬间释放动力，一路全速。强化后获得更持久的加速。', color: '#d6ad44' },
};

const progressStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};
const initialDifficulty = readSelectedDifficulty(progressStorage);
let selectedSkin = readSelectedSkin(progressStorage);
let skinSaveStatus = '选中即穿戴';
try {
  if (isSkinId(progressStorage.getItem('sand-rally-skin-v1'))) skinSaveStatus = '已记住你的选择';
} catch { skinSaveStatus = '存储受限 · 仅本次有效'; }
const app = document.querySelector<HTMLElement>('#app')!;
const routePath = minimapPath(122, 172, 8);
const racePath = minimapPath(136, 196, 12);
app.innerHTML = `
  <div id="viewport"></div>
  <div class="scene-wash" aria-hidden="true"></div>
  <div class="grain" aria-hidden="true"></div>
  <div id="speed-effects" aria-hidden="true"></div>
  <div id="hit-effects" aria-hidden="true"></div>
  <header class="topbar">
    <a class="brand" href="#" aria-label="赤沙狂飙赛事大厅" id="brand-home">
      <span class="brand-mark"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="m7 29 9-20h12c12 0 10 13 1 16l6 4H24l-6-7-3 7Zm14-12h4c3 0 4-3 1-3h-3Z" fill="currentColor"/></svg></span>
      <span class="brand-copy">RED SAND<span>RALLY CLUB</span></span>
    </a>
    <div class="topbar-center"><span class="live-dot"></span><span id="header-status">荒原特别赛 · 单人竞速</span></div>
    <nav class="topbar-actions" aria-label="游戏操作">
      <button class="text-button help-button" data-help>驾驶指南 ${icon('help')}</button>
      <span class="toolbar-divider"></span>
      <button class="icon-button" id="music-button" popovertarget="music-panel" aria-label="音乐与音效设置" title="赤沙电台 · 音乐与音效">${icon('music')}</button>
      <button class="icon-button" id="sound-button" aria-label="开启声音" title="声音">${icon('mute')}</button>
      <button class="icon-button quality-button" id="quality-button" aria-label="切换为流畅画质" title="画质：精细">${icon('settings')}</button>
      <button class="icon-button fullscreen-button" id="fullscreen-button" aria-label="进入全屏" title="全屏">${icon('fullscreen')}</button>
      <button class="icon-button pause-button" id="pause-button" aria-label="暂停比赛" title="暂停 · Esc" hidden>${icon('pause')}</button>
    </nav>
  </header>

  <section id="music-panel" class="audio-panel" popover="auto" aria-labelledby="audio-title">
    <div class="audio-panel-heading"><span class="small-label">RED SAND RADIO</span><button class="icon-button" popovertarget="music-panel" popovertargetaction="hide" aria-label="关闭音乐设置">${icon('close')}</button></div>
    <div class="radio-track"><span class="radio-art">${icon('music')}</span><div><h2 id="audio-title">${MUSIC_TITLE}</h2><p>原创电子配乐 <span>· ${MUSIC_BPM} BPM</span></p></div></div>
    <div class="radio-status"><span id="radio-status-dot"></span><span id="radio-status">点击后启用声音</span></div>
    <div class="audio-toggle-row"><span>背景音乐</span><button id="music-toggle" class="audio-toggle" aria-label="背景音乐" aria-pressed="true"><span></span></button></div>
    <label class="audio-range-label" for="music-volume"><span>音乐音量</span><output id="music-volume-value" for="music-volume">40%</output></label>
    <input id="music-volume" class="audio-range" type="range" min="0" max="100" step="1" value="40" aria-label="音乐音量" />
    <label class="audio-range-label" for="effects-volume"><span>引擎与道具音效</span><output id="effects-volume-value" for="effects-volume">80%</output></label>
    <input id="effects-volume" class="audio-range" type="range" min="0" max="100" step="1" value="80" aria-label="音效音量" />
    <p class="audio-panel-tip">比赛加入鼓点，氮气加一层节奏。<br>暂停和切换窗口时，音乐也会暂停。</p>
  </section>

  <section id="menu" aria-label="赛事大厅">
    <div class="menu-copy">
      <p class="eyebrow"><span></span> FULL THROTTLE. NO MERCY.</p>
      <h1>赤沙<span class="headline-second">狂飙<span class="title-dot">.</span></span></h1>
      <p class="menu-tagline">在尘土落定之前，成为第一。</p>
      <p class="menu-description">漂移蓄能，武装超车。<br>驶入荒原，留给对手一道尾烟。</p>
      ${skinPickerMarkup(selectedSkin)}
      <fieldset class="difficulty-selector" aria-describedby="difficulty-description">
        <legend>挑战难度 <span id="difficulty-subtitle">${DIFFICULTIES[initialDifficulty].subtitle}</span></legend>
        <div class="difficulty-options">${DIFFICULTY_ORDER.map((level, index) => `<label class="difficulty-option" data-tier="${level}" style="--tier-color:${DIFFICULTIES[level].color}"><input type="radio" name="difficulty" value="${level}" aria-label="${DIFFICULTIES[level].label}" ${level === initialDifficulty ? 'checked' : ''}/><span class="tier-bars" aria-hidden="true">${[0, 1, 2].map(bar => `<i class="${bar <= index ? 'is-filled' : ''}"></i>`).join('')}</span><strong>${DIFFICULTIES[level].label}</strong><span class="tier-check" aria-hidden="true">${icon('check')}</span></label>`).join('')}</div>
        <p id="difficulty-description" class="difficulty-description" aria-live="polite">${DIFFICULTIES[initialDifficulty].description}</p>
      </fieldset>
      <div class="menu-actions">
        <button class="primary-button start-button" id="start-button"><span>${icon('flag')} 开始比赛</span>${icon('arrow')}</button>
        <button class="secondary-button" data-help aria-label="查看驾驶指南">${icon('help')} 如何驾驶</button>
      </div>
      <div class="personal-best">${icon('trophy')}<span id="best-label">简单最佳</span><strong id="personal-best">等待你的第一条纪录</strong></div>
    </div>
    <aside class="track-card" aria-label="赛道信息">
      <div class="track-card-map"><svg viewBox="0 0 122 172" role="img" aria-label="赤沙峡谷赛道轮廓"><path d="${routePath}" class="route-shadow"/><path d="${routePath}" class="route-line"/><circle cx="${minimapPoint(0, 122, 172, 8).x}" cy="${minimapPoint(0, 122, 172, 8).y}" r="4" class="route-start"/></svg></div>
      <div class="track-card-info"><p class="small-label">THE BADLANDS</p><h2>赤沙峡谷</h2><p class="track-detail">高架环线 · 风蚀峡谷</p><div class="track-numbers"><span><strong>03</strong> 圈</span><span><strong>06</strong> 车手</span><span><strong>${(TRACK_LENGTH / 1000).toFixed(2)}</strong> km</span></div><div class="track-weather">${icon('sun')} 干燥路面 <span>抓地力良好</span></div></div>
    </aside>
    <footer class="menu-footer"><div class="quick-keys"><span><kbd>W A S D</kbd> 驾驶</span><span><kbd>SPACE</kbd> 漂移</span><span><kbd>E</kbd> 使用道具</span></div><span class="footer-motto">CHASE THE HORIZON.</span></footer>
  </section>

  <section id="hud" aria-label="比赛仪表" hidden>
    <div class="position-panel"><span class="hud-label">POSITION / 名次</span><div class="position-number"><strong id="rank">6</strong><span>/ 6</span></div><span id="race-difficulty" class="race-tier">简单</span><div id="leaderboard" class="leaderboard"></div></div>
    <div class="race-clock"><div class="lap-pill"><span>第 <strong id="lap">1</strong> 圈</span><span>/ 3</span></div><strong id="race-time">00:00.00</strong><span id="lap-notice">一路向前，抢占内线</span></div>
    <div class="race-minimap"><span class="hud-label">赤沙峡谷</span><svg viewBox="0 0 136 196" aria-label="实时赛道小地图"><path d="${racePath}" class="minimap-border"/><path d="${racePath}" class="minimap-track"/><g id="map-dots"></g></svg><span class="map-caption">THE BADLANDS</span></div>
    <div class="item-panel" id="item-panel"><div class="item-box" id="item-icon">${icon('empty')}</div><div class="item-info"><span class="hud-label" id="item-eyebrow">战斗拾取</span><strong id="item-name">寻找补给</strong><span id="item-hint">驶过发光道具箱</span></div><kbd>E</kbd><div class="charge-track"><div id="charge-fill"></div></div></div>
    <div class="drift-indicator" id="drift-indicator" hidden>
      <div class="drift-heading">${icon('nitro')}<strong id="drift-label">漂移积累</strong><span id="drift-hint">保持漂移</span></div>
      <div class="drift-track" role="progressbar" aria-label="出弯小喷积累" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="drift-fill"></div></div>
      <span id="drift-charge" class="drift-charge" hidden></span>
    </div>
    <div id="threat-warning" class="threat-warning" role="status" hidden>
      <span class="threat-bearing" aria-hidden="true">${icon('chevron')}</span>
      <div class="threat-copy"><strong id="threat-label"></strong><span id="threat-action"></span></div>
      <span id="threat-distance" aria-hidden="true"></span>
    </div>
    <div id="target-lock" class="target-lock" hidden>${icon('rocket')}<span id="target-label"></span></div>
    <div id="target-reticle" class="target-reticle" aria-hidden="true" hidden><i></i><i></i><i></i><i></i></div>
    <div id="combat-confirmation" class="combat-confirmation" role="status" hidden>${icon('check')}<span id="combat-confirmation-text"></span></div>
    <div class="speed-panel"><div class="speed-ticks" aria-hidden="true">${Array.from({ length: 25 }, (_, i) => `<i style="--tick:${i}"></i>`).join('')}</div><div class="speed-number"><strong id="speed">000</strong><span>KM/H</span></div><div class="nitro-label"><span>${icon('nitro')} 氮气储备</span><kbd>SHIFT</kbd></div><div class="nitro-track"><div id="nitro-fill"></div></div><div class="speed-foot"><span id="drive-status">准备发车</span><span id="energy-label">100%</span></div></div>
    <div class="race-key-hint"><kbd>SPACE</kbd> 漂移 <span>·</span> <kbd>R</kbd> 复位 <span>·</span> <kbd>ESC</kbd> 暂停</div>
    <div class="portrait-hint">横屏驾驶，视野更开阔</div>
    <div id="touch-controls" class="touch-controls" aria-label="触屏驾驶">
      <div class="touch-steering"><button data-control="left" aria-label="左转">${icon('arrowLeft')}</button><button data-control="right" aria-label="右转">${icon('arrow')}</button><button data-control="brake" class="touch-small" aria-label="刹车">刹车</button></div>
      <div class="touch-driving"><button data-control="item" aria-label="使用道具">${icon('rocket')}</button><button data-control="drift" class="touch-small" aria-label="漂移">漂移</button><button data-control="boost" aria-label="氮气加速">${icon('nitro')}</button><button data-control="throttle" class="touch-accelerate" aria-label="油门">油门 ${icon('chevron')}</button></div>
    </div>
  </section>

  <div id="countdown" class="countdown" aria-live="assertive" hidden><span>点燃引擎</span><strong>3</strong><small>按住 W / ↑ 加速</small></div>
  <div id="toast" role="status" class="toast" hidden></div>
  <div id="loading" class="loading"><span class="loading-mark">R</span><strong>荒原正在苏醒</strong><span>点燃引擎，准备出发</span><i></i></div>

  <dialog id="help-dialog" class="panel-dialog help-dialog" aria-labelledby="help-title"><button class="dialog-close icon-button" data-close="help-dialog" aria-label="关闭驾驶指南">${icon('close')}</button><p class="eyebrow">THE DRIVER'S HANDBOOK</p><h2 id="help-title">先学会漂移，<br>再学会超越。</h2><div class="help-columns"><div><h3>掌控你的赛车</h3><dl class="control-list"><div><dt><kbd>W</kbd> <kbd>↑</kbd></dt><dd>加速</dd></div><div><dt><kbd>S</kbd> <kbd>↓</kbd></dt><dd>刹车 / 倒车</dd></div><div><dt><kbd>A D</kbd> <kbd>← →</kbd></dt><dd>左右转向</dd></div><div><dt><kbd>SPACE</kbd> + 转向</dt><dd>漂移蓄能</dd></div><div><dt><kbd>SHIFT</kbd></dt><dd>氮气冲刺</dd></div><div><dt><kbd>E</kbd></dt><dd>使用道具</dd></div><div><dt><kbd>R</kbd> / <kbd>ESC</kbd></dt><dd>赛车复位 / 暂停</dd></div></dl></div><div><h3>把弯道变成武器</h3><p class="help-intro">持续漂移可以强化手中的道具。抢占补给路线，选择出手时机；受击后会获得短暂保护，不会被淘汰。</p><div class="weapon-grid">${Object.entries(ITEMS).map(([key, item]) => `<div class="weapon-guide" style="--item-color:${item.color}">${icon(key)}<div><strong>${item.name}</strong><p>${item.description}</p></div></div>`).join('')}</div></div></div><div class="help-footer"><span>${icon('flag')} 完成三圈，率先冲线。触屏设备支持屏幕按钮。</span><button class="primary-button compact-button" data-close="help-dialog">明白了 ${icon('arrow')}</button></div></dialog>

  <dialog id="pause-dialog" class="panel-dialog pause-dialog" aria-labelledby="pause-title"><p class="eyebrow">TAKE A BREATHER.</p><h2 id="pause-title">尘土会等你。</h2><p class="dialog-description">比赛已暂停。准备好了，就回到赛道。</p><p id="pause-difficulty" class="pause-difficulty">简单 · 本场难度</p><div class="pause-actions"><button id="resume-button" class="primary-button">继续比赛 ${icon('play')}</button><button id="restart-button" class="secondary-button">${icon('reset')} 重新开始</button><button id="lobby-button" class="text-button">返回赛事大厅 ${icon('arrow')}</button></div><p class="pause-tip"><kbd>ESC</kbd> 继续比赛</p></dialog>

  <dialog id="results-dialog" class="panel-dialog results-dialog" aria-labelledby="result-title"><div class="result-top"><p class="eyebrow">THE DUST HAS SETTLED.</p><span id="result-difficulty" class="result-tier">简单难度</span>${icon('flag')}</div><div class="result-heading"><div><h2 id="result-title">漂亮的一战。</h2><p id="result-subtitle">每一道轮胎印，都是你的轨迹。</p></div><div class="result-position"><strong id="result-rank">1</strong><span>/ 6</span></div></div><div class="result-stats"><div><span>完赛用时</span><strong id="result-time">—</strong></div><div><span>最佳单圈</span><strong id="result-lap">—</strong></div><div><span>有效命中</span><strong id="result-hits">0</strong></div><div><span>漂移次数</span><strong id="result-drifts">0</strong></div></div><div id="result-list" class="result-list"></div><div class="result-actions"><button class="primary-button" id="race-again-button">再飙一场 ${icon('reset')}</button><button class="secondary-button" id="results-lobby-button">返回大厅 ${icon('arrow')}</button></div></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const simulation = new RaceSimulation(undefined, initialDifficulty);
const audio = new GameAudio();
const audioEvents = new AbortController();
let renderer: RaceRenderer;
let touchMode = window.matchMedia('(pointer: coarse), (max-width: 700px)').matches;
document.body.dataset.inputMode = touchMode ? 'touch' : 'keyboard';
const feedback = new RaceFeedbackHUD($('#hud'), audio, () => touchMode,
  racer => renderer?.projectRacer(racer) ?? null);
let previousPhase: GamePhase | null = null;
let toastTimer = 0;
let toastPriority = 0;
let toastUntil = 0;
let countdownValue = '';
let goUntil = 0;
let lastUiUpdate = 0;
let lastItem = 'initial';
let currentQuality = true;
let helpPausedRace = false;
const sessionBests: Record<Difficulty, number> = {
  easy: readBestTime(progressStorage, 'easy'),
  hard: readBestTime(progressStorage, 'hard'),
  hell: readBestTime(progressStorage, 'hell'),
};
let previousDifficulty: Difficulty | null = null;
let animationFrame = 0;
let disposed = false;
let previousSoundIcon: boolean | null = null;
let previousMusicIcon: boolean | null = null;

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}.${Math.floor((value % 1) * 100).toString().padStart(2, '0')}`;
}
function bestFor(difficulty: Difficulty) {
  return Math.min(sessionBests[difficulty], readBestTime(progressStorage, difficulty));
}
function refreshBest() {
  const difficulty = simulation.state.difficulty;
  const best = bestFor(difficulty);
  $('#best-label').textContent = `${DIFFICULTIES[difficulty].label}最佳`;
  $('#personal-best').textContent = Number.isFinite(best) ? formatTime(best) : '等待你的第一条纪录';
}
function refreshDifficulty(animate = false) {
  const { difficulty, phase } = simulation.state;
  const profile = DIFFICULTIES[difficulty];
  document.body.dataset.difficulty = difficulty;
  document.body.style.setProperty('--difficulty-color', profile.color);
  document.querySelectorAll<HTMLInputElement>('input[name="difficulty"]').forEach(option => {
    option.checked = option.value === difficulty;
    option.disabled = phase !== 'menu';
    option.closest('.difficulty-option')?.classList.toggle('is-selected', option.checked);
  });
  $('#difficulty-subtitle').textContent = profile.subtitle;
  $('#difficulty-description').textContent = profile.description;
  $('#race-difficulty').textContent = `${profile.label}难度`;
  $('#pause-difficulty').textContent = `${profile.label} · 本场难度`;
  $('#result-difficulty').textContent = `${profile.label}难度`;
  $('#header-status').textContent = phase === 'menu' ? `荒原特别赛 · ${profile.label}` : phase === 'paused' ? `${profile.label} · 赛事暂停` : phase === 'finished' ? `${profile.label} · 尘埃落定` : `赤沙峡谷 · ${profile.label}`;
  refreshBest();
  refreshSkinPicker();
  if (animate && previousDifficulty !== difficulty) {
    gsap.fromTo('#difficulty-description', { opacity: 0.25, y: 4 }, { opacity: 1, y: 0, duration: 0.24, overwrite: true });
  }
  previousDifficulty = difficulty;
}
document.querySelectorAll<HTMLInputElement>('input[name="difficulty"]').forEach(option => {
  option.addEventListener('change', () => {
    if (!isDifficulty(option.value) || !simulation.setDifficulty(option.value)) { refreshDifficulty(); return; }
    saveSelectedDifficulty(progressStorage, option.value);
    refreshDifficulty(true);
    audio.play('click');
  });
});
refreshDifficulty();

function refreshSkinPicker(animate = false) {
  const skin = SKINS[selectedSkin];
  document.body.dataset.skin = selectedSkin;
  $<HTMLFieldSetElement>('#skin-picker').disabled = simulation.state.phase !== 'menu';
  document.querySelectorAll<HTMLInputElement>('input[name="skin"]').forEach(option => {
    option.checked = option.value === selectedSkin;
    option.closest('.skin-option')?.classList.toggle('is-selected', option.checked);
  });
  $('#skin-name').textContent = skin.name;
  $('#skin-description').textContent = skin.description;
  $('#skin-save-status').textContent = skinSaveStatus;
  $('#skin-save-status').classList.toggle('is-unsaved', /未保存|受限/.test(skinSaveStatus));
  if (animate) gsap.fromTo('.skin-heading', { opacity: 0.55, y: 3 },
    { opacity: 1, y: 0, duration: 0.22, overwrite: true });
}
paintSkinSwatches($('#skin-picker'));
document.querySelectorAll<HTMLInputElement>('input[name="skin"]').forEach(option => {
  option.addEventListener('change', () => {
    if (simulation.state.phase !== 'menu' || !isSkinId(option.value) || !renderer?.setPlayerSkin(option.value)) {
      refreshSkinPicker(); return;
    }
    selectedSkin = option.value;
    skinSaveStatus = saveSelectedSkin(progressStorage, selectedSkin) ? '已保存到本机' : '未保存 · 仅本次有效';
    refreshSkinPicker(true);
    audio.play('click');
  }, { signal: audioEvents.signal });
});

function updateSound() {
  if (previousSoundIcon !== audio.muted) {
    previousSoundIcon = audio.muted;
    $('#sound-button').innerHTML = icon(audio.muted ? 'mute' : 'volume');
  }
  $('#sound-button').setAttribute('aria-label', audio.muted ? '开启声音' : '静音');
  $('#sound-button').setAttribute('aria-pressed', String(!audio.muted));
  $('#sound-button').title = audio.muted ? '开启声音' : '静音';
  const musicOn = audio.musicEnabled && audio.musicVolume > 0;
  if (previousMusicIcon !== musicOn) {
    previousMusicIcon = musicOn;
    $('#music-button').innerHTML = icon(musicOn ? 'music' : 'musicOff');
  }
  $('#music-toggle').setAttribute('aria-pressed', String(audio.musicEnabled));
  $<HTMLInputElement>('#music-volume').value = String(Math.round(audio.musicVolume * 100));
  $<HTMLInputElement>('#effects-volume').value = String(Math.round(audio.effectsVolume * 100));
  $('#music-volume-value').textContent = `${Math.round(audio.musicVolume * 100)}%`;
  $('#effects-volume-value').textContent = `${Math.round(audio.effectsVolume * 100)}%`;
  const snapshot = audio.snapshot;
  const quiet = snapshot.music?.mode === 'paused' || snapshot.music?.mode === 'hidden';
  $('#radio-status').textContent = snapshot.contextState === 'locked' ? '点击后启用声音' : audio.muted ? '总声音已静音' : !audio.musicEnabled ? '背景音乐已关闭' : audio.musicVolume === 0 ? '音乐音量为零' : quiet ? '音乐已暂停' : simulation.state.phase === 'racing' ? '正在播放 · 全速版' : '正在播放 · 巡航版';
  $('#radio-status-dot').classList.toggle('is-playing', snapshot.contextState === 'running' && !audio.muted && audio.musicEnabled && audio.musicVolume > 0 && !quiet);
}
updateSound();

function unlockAudio() { void audio.unlock().then(updateSound); }
// Browser policy requires a real gesture. Opening the page never starts audible playback.
document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Element) || !event.target.closest('#sound-button')) unlockAudio();
}, { once: true, signal: audioEvents.signal });
document.addEventListener('keydown', unlockAudio, { once: true, signal: audioEvents.signal });
window.addEventListener('blur', () => { audio.setFocused(false); updateSound(); }, { signal: audioEvents.signal });
window.addEventListener('focus', () => { audio.setFocused(true); updateSound(); }, { signal: audioEvents.signal });

function closeDialogs() {
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
  helpPausedRace = false;
}
function requestPause(reason: 'keyboard' | 'blur' = 'blur') {
  if (reason === 'keyboard') {
    if ($('#music-panel').matches(':popover-open')) { $('#music-panel').hidePopover(); return; }
    if ($<HTMLDialogElement>('#help-dialog').open) { closeHelp(); return; }
    if (simulation.state.phase === 'paused') { resumeRace(); return; }
    if (simulation.state.phase === 'finished') { returnToMenu(); return; }
  }
  if (simulation.state.phase !== 'racing' && simulation.state.phase !== 'countdown') return;
  simulation.pause(); input.clear();
  if (!$('#help-dialog').hasAttribute('open')) $('#pause-dialog').hasAttribute('open') || $<HTMLDialogElement>('#pause-dialog').showModal();
}
const input = new GameInput(requestPause);
input.bindTouch($('#touch-controls'));
function setInputMode(touch: boolean) {
  if (touchMode === touch) return;
  touchMode = touch;
  document.body.dataset.inputMode = touch ? 'touch' : 'keyboard';
  lastItem = 'initial';
  if (simulation.state.phase === 'countdown') $('#countdown small').textContent = touch ? '按住油门加速' : '按住 W / ↑ 加速';
}
document.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' || (event.target instanceof Element && event.target.closest('[data-control]'))) setInputMode(true);
}, { signal: audioEvents.signal });
document.addEventListener('keydown', event => {
  if (/^(Key[WASDER]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right))$/.test(event.code) &&
    !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) setInputMode(false);
}, { signal: audioEvents.signal });

function resumeRace() {
  $<HTMLDialogElement>('#pause-dialog').close();
  input.clear(); simulation.resume(); audio.unlock().catch(() => undefined);
}
function startRace() {
  closeDialogs(); input.clear();
  window.clearTimeout(toastTimer);
  $('#toast').hidden = true;
  toastPriority = 0; toastUntil = 0;
  feedback.reset();
  goUntil = 0;
  audio.unlock().catch(() => undefined);
  audio.play('click');
  countdownValue = ''; lastItem = 'initial';
  $('#countdown small').textContent = touchMode ? '按住油门加速' : '按住 W / ↑ 加速';
  simulation.start();
  ($('#start-button') as HTMLButtonElement).blur();
}
function returnToMenu() {
  closeDialogs(); input.clear(); simulation.returnToMenu();
  feedback.reset();
  window.clearTimeout(toastTimer); toastPriority = 0; toastUntil = 0;
  $('#countdown').hidden = true; $('#toast').hidden = true;
}
function openHelp() {
  helpPausedRace = simulation.state.phase === 'racing' || simulation.state.phase === 'countdown';
  if (helpPausedRace) { simulation.pause(); input.clear(); }
  $<HTMLDialogElement>('#help-dialog').showModal();
  audio.play('click');
}
function closeHelp() {
  $<HTMLDialogElement>('#help-dialog').close();
  input.clear();
  if (helpPausedRace) { simulation.resume(); helpPausedRace = false; }
}

$('#start-button').addEventListener('click', startRace);
$('#resume-button').addEventListener('click', resumeRace);
$('#restart-button').addEventListener('click', startRace);
$('#race-again-button').addEventListener('click', startRace);
$('#lobby-button').addEventListener('click', returnToMenu);
$('#results-lobby-button').addEventListener('click', returnToMenu);
$('#pause-button').addEventListener('click', () => requestPause());
$('#brand-home').addEventListener('click', event => { event.preventDefault(); if (simulation.state.phase === 'racing' || simulation.state.phase === 'countdown') requestPause(); else if (simulation.state.phase === 'finished') returnToMenu(); });
document.querySelectorAll('[data-help]').forEach(button => button.addEventListener('click', openHelp));
document.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => button.dataset.close === 'help-dialog' ? closeHelp() : $<HTMLDialogElement>(`#${button.dataset.close}`).close()));
$<HTMLDialogElement>('#help-dialog').addEventListener('cancel', event => { event.preventDefault(); closeHelp(); });
$<HTMLDialogElement>('#pause-dialog').addEventListener('cancel', event => { event.preventDefault(); resumeRace(); });
$<HTMLDialogElement>('#results-dialog').addEventListener('cancel', event => { event.preventDefault(); returnToMenu(); });
$('#sound-button').addEventListener('click', () => {
  audio.setMuted(!audio.muted); unlockAudio(); updateSound();
  if (!audio.muted) audio.play('click');
});
$('#music-button').addEventListener('click', unlockAudio);
$('#music-toggle').addEventListener('click', () => {
  audio.setMusicEnabled(!audio.musicEnabled); unlockAudio(); updateSound();
});
$('#music-volume').addEventListener('input', () => {
  audio.setMusicVolume(Number($<HTMLInputElement>('#music-volume').value) / 100); updateSound();
});
$('#effects-volume').addEventListener('input', () => {
  audio.setEffectsVolume(Number($<HTMLInputElement>('#effects-volume').value) / 100); updateSound();
});
$('#quality-button').addEventListener('click', () => {
  currentQuality = !currentQuality; renderer?.setQuality(currentQuality);
  $('#quality-button').setAttribute('aria-label', `切换为${currentQuality ? '流畅' : '精细'}画质`);
  $('#quality-button').title = `画质：${currentQuality ? '精细' : '流畅'}`;
  showToast(`${currentQuality ? '精细' : '流畅'}画质已启用`);
});
$('#fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { showToast('当前浏览器不支持全屏，请尝试最大化窗口'); }
});
document.addEventListener('fullscreenchange', () => $('#fullscreen-button').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) requestPause();
  audio.setFocused(!document.hidden && document.hasFocus()); updateSound();
}, { signal: audioEvents.signal });

function showToast(text: string, priority = 0) {
  if (priority < toastPriority && performance.now() < toastUntil) return;
  window.clearTimeout(toastTimer);
  toastPriority = priority; toastUntil = performance.now() + 2600;
  const toast = $('#toast'); toast.textContent = text; toast.hidden = false;
  gsap.fromTo(toast, { y: -10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.25, overwrite: true });
  toastTimer = window.setTimeout(() => { toast.hidden = true; toastPriority = 0; }, 2600);
}

function showResults() {
  const state = simulation.state;
  const player = state.racers[0];
  const difficulty = state.difficulty;
  $('#result-rank').textContent = String(player.rank);
  $('#result-title').textContent = player.rank === 1 ? '荒原，为你加冕。' : player.rank <= 3 ? '漂亮的一战。' : '下一次，冲得更远。';
  $('#result-subtitle').textContent = player.rank === 1 ? '把尘土与对手，一起留在身后。' : '每一道轮胎印，都是你的轨迹。';
  $('#result-time').textContent = formatTime(player.finishTime || state.time);
  $('#result-lap').textContent = state.bestLap > 0 ? formatTime(state.bestLap) : '—';
  $('#result-hits').textContent = String(state.hits);
  $('#result-drifts').textContent = String(state.drifts);
  $('#result-list').innerHTML = [...state.racers].sort((a, b) => a.rank - b.rank).map(r => `<div class="result-row ${r.isPlayer ? 'is-you' : ''}"><span>${String(r.rank).padStart(2, '0')}</span><i style="background:#${r.color.toString(16).padStart(6, '0')}"></i><strong>${r.name}${r.isPlayer ? '<small>你</small>' : ''}</strong><span>${r.finished ? formatTime(r.finishTime) : '未冲线'}</span></div>`).join('');
  const finishTime = player.finishTime || state.time;
  if (Number.isFinite(finishTime) && finishTime > 0 && finishTime < bestFor(difficulty)) {
    sessionBests[difficulty] = finishTime;
    const saved = saveBestTime(progressStorage, difficulty, finishTime);
    refreshBest();
    $('#result-subtitle').textContent = saved ? `${DIFFICULTIES[difficulty].label}新纪录。你的极限，刚刚被改写。` : `${DIFFICULTIES[difficulty].label}新纪录 · 当前浏览器未能保存`;
  }
  $<HTMLDialogElement>('#results-dialog').showModal();
  gsap.fromTo('#results-dialog', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' });
}

function syncPhase(now: number) {
  const phase = simulation.state.phase;
  if (phase === previousPhase) return;
  const was = previousPhase;
  previousPhase = phase;
  audio.setPhase(phase);
  updateSound();
  document.body.dataset.phase = phase;
  refreshDifficulty();
  const menu = phase === 'menu';
  $('#menu').hidden = !menu; $('#hud').hidden = menu;
  if (menu) $('#speed-effects').style.opacity = '0';
  $('#pause-button').hidden = menu || phase === 'finished';
  if (menu) {
    gsap.fromTo('.menu-copy > *, .track-card, .vehicle-caption', { y: 18, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.065, duration: 0.75, ease: 'power3.out', overwrite: true });
    // Keep the footer's touch/key hints inside the viewport throughout the entrance.
    gsap.fromTo('.menu-footer', { y: 0, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, overwrite: true });
  }
  if (phase === 'countdown' && was !== 'paused') gsap.fromTo('#hud', { opacity: 0 }, { opacity: 1, duration: 0.65 });
  if (phase === 'racing' && was === 'countdown') {
    goUntil = now + 1100; $('#countdown').hidden = false;
    $('#countdown strong').textContent = 'GO!'; $('#countdown span').textContent = '把对手留在身后';
    $('#countdown small').textContent = ''; audio.play('go');
    gsap.fromTo('#countdown strong', { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3 });
  }
  if (phase === 'finished') { $('#countdown').hidden = true; input.clear(); showResults(); }
}

function handleEvent(event: GameEvent) {
  renderer.event(event, simulation.state);
  feedback.event(event, simulation.state);
  if (event.type === 'hit' && event.racer !== 0 && event.text === 'DIRECT HIT!') {
    audio.play('hitConfirm');
  }
  if (event.racer !== 0 || event.type === 'countdown') return;
  audio.play(event.type);
  if (event.type === 'collision') {
    if (event.text === 'PROJECTILE_BLOCKED') showToast('火箭击中障碍物', 1);
    else if ((event.strength ?? 0) > 0.28) showToast(event.collisionKind === 'car' ? '车身碰撞 · 稳住方向' : event.collisionKind === 'barrier' ? '擦碰护栏 · 松开转向' : touchMode ? '撞到障碍 · 按住刹车倒车' : '撞到障碍 · 倒车或按 R 复位', 1);
  }
  if (event.type === 'pickup' && event.item) showToast(`已拾取 · ${ITEMS[event.item].name}　${touchMode ? '点道具按钮' : '按 E 使用'}`);
  if (event.type === 'hit') {
    showToast('遭到攻击 · 短暂保护已生效', 3);
    gsap.fromTo('#hit-effects', { opacity: 0.7 }, { opacity: 0, duration: 0.65 });
  }
  if (event.type === 'lap') showToast(event.text || `第 ${simulation.state.racers[0].lap} 圈 · 继续冲刺`);
  if (event.type === 'reset') showToast('已回到赛道 · 全速出发', 2);
}

function updateUI(now: number) {
  const state = simulation.state;
  const player = state.racers[0];
  feedback.update(state);
  if (state.phase === 'countdown') {
    const value = String(Math.max(1, Math.ceil(state.countdown)));
    $('#countdown').hidden = false;
    if (value !== countdownValue) {
      countdownValue = value;
      $('#countdown strong').textContent = value;
      $('#countdown span').textContent = '点燃引擎';
      audio.play('countdown');
      gsap.fromTo('#countdown strong', { scale: 1.3, opacity: 0.3 }, { scale: 1, opacity: 1, duration: 0.38, ease: 'power3.out' });
    }
  } else if (state.phase !== 'paused' && now > goUntil) $('#countdown').hidden = true;
  if (state.phase === 'menu') return;
  $('#speed-effects').style.opacity = player.boostTime > 0 ? '0.6' : '0';
  if (now - lastUiUpdate < 65) return;
  lastUiUpdate = now;
  $('#rank').textContent = String(player.rank);
  $('#lap').textContent = String(Math.min(3, Math.max(1, player.lap)));
  $('#race-time').textContent = formatTime(state.time);
  $('#speed').textContent = String(Math.round(Math.abs(player.speed) * 3.6)).padStart(3, '0');
  $('.speed-panel').style.setProperty('--speed', String(Math.min(Math.abs(player.speed) / 78, 1)));
  $('#nitro-fill').style.width = `${Math.max(0, Math.min(100, player.energy))}%`;
  $('#energy-label').textContent = `${Math.round(player.energy)}%`;
  $('#drive-status').textContent = player.hitTime > 0 ? '受到攻击' : player.collisionTime > 0 ? '车身碰撞 · 稳住方向' : Math.abs(player.lateral) > 9.5 ? '沙地 · 抓地力下降' : player.boostTime > 0 ? '氮气全开' : player.shield > 0 ? '护盾保护中' : player.speed < -1 ? '倒车中' : player.speed > 1 ? '全速向前' : touchMode ? '按住油门加速' : '按 W 加速';
  $('#lap-notice').textContent = player.lap === 3 ? '最后一圈 · 放手一搏' : state.bestLap > 0 && Number.isFinite(state.bestLap) ? `最佳单圈 ${formatTime(state.bestLap)}` : '一路向前，抢占内线';
  $('#leaderboard').innerHTML = [...state.racers].sort((a, b) => a.rank - b.rank).map(r => `<div class="leader-row ${r.isPlayer ? 'is-you' : ''}"><span>${r.rank}</span><i style="background:#${r.color.toString(16).padStart(6, '0')}"></i><strong>${r.name}</strong>${r.isPlayer ? '<small>YOU</small>' : ''}</div>`).join('');
  $('#map-dots').innerHTML = [...state.racers].reverse().map(r => { const point = minimapPoint(r.distance, 136, 196, 12); return `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${r.isPlayer ? 4.7 : 3}" fill="${r.isPlayer ? '#ff683b' : '#f9f0da'}" stroke="${r.isPlayer ? '#fff2d6' : '#303b39'}" stroke-width="1.5"/>`; }).join('');
  const itemKey = `${player.item}-${player.charge >= 0.99}`;
  if (itemKey !== lastItem) {
    lastItem = itemKey;
    const data = player.item ? ITEMS[player.item] : null;
    $('#item-panel').style.setProperty('--item-color', data?.color ?? '#d6cfbb');
    $('#item-panel').classList.toggle('has-item', !!data);
    $('#item-panel').classList.toggle('is-powered', player.charge >= 0.99 && !!data);
    $('#item-icon').innerHTML = icon(player.item ?? 'empty');
    $('#item-name').textContent = data ? data.name : '寻找补给';
    const itemAction = touchMode ? '点道具' : '按 E';
    $('#item-hint').textContent = data ? player.charge >= 0.99 ? `已强化 · ${itemAction}释放` : `${itemAction}使用 · 漂移可强化` : '驶过发光道具箱';
    $('#item-eyebrow').textContent = data ? player.charge >= 0.99 ? 'OVERCHARGED / 强化' : 'READY TO FIRE / 就绪' : '战斗拾取';
    const touchItem = $('[data-control="item"]');
    touchItem.innerHTML = icon(player.item ?? 'empty');
    touchItem.setAttribute('aria-label', data ? `使用道具：${data.name}${player.charge >= 0.99 ? '（已强化）' : ''}` : '使用道具（尚未拾取）');
    touchItem.classList.toggle('is-powered', !!data && player.charge >= 0.99);
    if (data) gsap.fromTo('#item-icon', { scale: 0.8, rotate: -8 }, { scale: 1, rotate: 0, duration: 0.4, ease: 'back.out(2)' });
  }
  $('#charge-fill').style.width = `${Math.min(player.charge, 1) * 100}%`;
}

try {
  renderer = new RaceRenderer($('#viewport'));
  renderer.setPlayerSkin(selectedSkin);
  simulation.setStaticColliders(renderer.staticColliders);
  let lastTime = performance.now();
  function frame(now: number) {
    if (disposed) return;
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    simulation.update(dt, input.read());
    for (const event of simulation.state.events) handleEvent(event);
    syncPhase(now);
    renderer.update(simulation.state, dt);
    updateUI(now);
    const player = simulation.state.racers[0];
    audio.update(player.speed, player.boostTime > 0, player.driftTime > 0.15, simulation.state.phase === 'racing');
    animationFrame = requestAnimationFrame(frame);
  }
  renderer.update(simulation.state, 0.016);
  gsap.to('#loading', { opacity: 0, duration: 0.45, delay: 0.2, onComplete: () => { $('#loading').hidden = true; } });
  animationFrame = requestAnimationFrame(frame);
  if (import.meta.env.DEV) {
    Object.defineProperty(window, '__RALLY__', { value: { simulation, renderer, input, audio, startRace, returnToMenu }, configurable: true });
  }
} catch (error) {
  console.error(error);
  $('#loading').innerHTML = `<span class="loading-mark">R</span><strong>引擎暂时无法启动</strong><span>请使用支持 WebGL 2 的新版 Chrome、Edge 或 Safari，并开启硬件加速。</span><button class="primary-button" id="reload-button">重新加载 ${icon('reset')}</button>`;
  $('#reload-button').addEventListener('click', () => location.reload());
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  cancelAnimationFrame(animationFrame);
  window.clearTimeout(toastTimer);
  gsap.globalTimeline.clear();
  audioEvents.abort();
  input.dispose(); audio.dispose(); renderer?.dispose();
  feedback.reset();
});
