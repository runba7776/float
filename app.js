'use strict';

/* ============================================================
   0. ユーティリティ
============================================================ */
async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function toast(msg, ms=2200){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=>t.classList.add('hidden'), ms);
}

/* ============================================================
   1. ロック画面(自分専用パスコード)
   - パスコードは外部に送信せず、SHA-256ハッシュのみ
     この端末のlocalStorageに保存します。
   - 初回起動時にパスコードを設定し、以後の起動毎に要求します。
============================================================ */
const LOCK_KEY = 'fc_pwhash_v1';

const lockScreen = document.getElementById('lockScreen');
const appEl      = document.getElementById('app');
const pwInput    = document.getElementById('pwInput');
const pwInput2   = document.getElementById('pwInput2');
const pwSubmit   = document.getElementById('pwSubmit');
const lockTitle  = document.getElementById('lockTitle');
const lockSub    = document.getElementById('lockSubtitle');
const lockError  = document.getElementById('lockError');
const pwReset    = document.getElementById('pwReset');

let isSetupMode = !localStorage.getItem(LOCK_KEY);

function renderLockMode(){
  if(isSetupMode){
    lockTitle.textContent = 'はじめに';
    lockSub.textContent = 'このアプリで使うパスコードを決めてください(自分だけが使う想定です)';
    pwInput.placeholder = '新しいパスコード';
    pwInput2.style.display = 'block';
    pwSubmit.textContent = '設定して開始';
    pwReset.classList.add('hidden');
  } else {
    lockTitle.textContent = 'FloatCam';
    lockSub.textContent = 'パスコードを入力してください';
    pwInput.placeholder = '••••';
    pwInput2.style.display = 'none';
    pwSubmit.textContent = '解除';
    pwReset.classList.remove('hidden');
  }
}
renderLockMode();

async function handleLockSubmit(){
  lockError.textContent = '';
  const v1 = pwInput.value.trim();
  if(v1.length < 4){
    lockError.textContent = '4文字以上で入力してください';
    return;
  }
  if(isSetupMode){
    const v2 = pwInput2.value.trim();
    if(v1 !== v2){
      lockError.textContent = 'パスコードが一致しません';
      return;
    }
    const hash = await sha256(v1);
    localStorage.setItem(LOCK_KEY, hash);
    unlockApp();
  } else {
    const hash = await sha256(v1);
    const stored = localStorage.getItem(LOCK_KEY);
    if(hash === stored){
      unlockApp();
    } else {
      lockError.textContent = 'パスコードが違います';
      pwInput.value = '';
    }
  }
}

function unlockApp(){
  lockScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  pwInput.value=''; pwInput2.value='';
  initAppOnce();
}

pwSubmit.addEventListener('click', handleLockSubmit);
pwInput.addEventListener('keydown', e=>{ if(e.key==='Enter') (isSetupMode? pwInput2.focus(): handleLockSubmit()); });
pwInput2.addEventListener('keydown', e=>{ if(e.key==='Enter') handleLockSubmit(); });

pwReset.addEventListener('click', ()=>{
  if(confirm('パスコードをリセットしますか？\nこの端末に保存された設定が消え、次回新しいパスコードを設定し直します。')){
    localStorage.removeItem(LOCK_KEY);
    isSetupMode = true;
    renderLockMode();
  }
});

document.getElementById('lockNow').addEventListener('click', ()=>{
  appEl.classList.add('hidden');
  lockScreen.classList.remove('hidden');
  isSetupMode = false;
  renderLockMode();
});

/* ============================================================
   2. カメラ初期化(無音撮影 / フロント・バック切替 / 倍率)
============================================================ */
let appInited = false;
let currentStream = null;
let usingFront = true;
let backDevices = []; // 背面カメラが複数(広角/超広角/望遠)に分かれて見える機種用
let currentDeviceIndex = 0;
let zoomCaps = null; // {min,max,step} ネイティブズームに対応している場合

const camVideo   = document.getElementById('cam');
const zoomSlider = document.getElementById('zoomSlider');
const zoomValue  = document.getElementById('zoomValue');
const zoomMaxLabel = document.getElementById('zoomMaxLabel');
const flipBtn    = document.getElementById('flipBtn');
const statusMsg  = document.getElementById('statusMsg');

async function initAppOnce(){
  if(appInited) return;
  appInited = true;
  await enumerateBackCameras();
  await startCamera();
  initBubbleDrag();
  initResize();
  initShutter();
  initRecorder();
  initBrowser();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}

async function enumerateBackCameras(){
  try{
    // ラベル取得のため一旦軽く許可を取る
    const tmp = await navigator.mediaDevices.getUserMedia({video:true});
    tmp.getTracks().forEach(t=>t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    backDevices = devices.filter(d=> d.kind==='videoinput' && /back|rear|environment/i.test(d.label));
    // 超広角(ultra wide)が先頭に来るよう並び替え(0.5x相当)
    backDevices.sort((a,b)=>{
      const score = l => /ultra ?wide/i.test(l) ? 0 : /telephoto/i.test(l) ? 2 : 1;
      return score(a.label) - score(b.label);
    });
  }catch(e){ /* 権限拒否時は後段の getUserMedia で再度ハンドリング */ }
}

async function startCamera(deviceIndexOverride){
  if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); }
  statusMsg.textContent = '';
  let constraints;
  if(usingFront){
    constraints = { video:{ facingMode:'user' }, audio:true };
  } else if(backDevices.length){
    currentDeviceIndex = deviceIndexOverride ?? currentDeviceIndex;
    constraints = { video:{ deviceId:{ exact: backDevices[currentDeviceIndex].deviceId } }, audio:true };
  } else {
    constraints = { video:{ facingMode:'environment' }, audio:true };
  }
  try{
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  }catch(e){
    statusMsg.textContent = 'カメラ/マイクへのアクセスが許可されていません';
    toast('カメラの利用を許可してください(設定アプリ > Safari)');
    return;
  }
  camVideo.srcObject = currentStream;
  camVideo.classList.toggle('no-mirror', !usingFront);
  setupZoomForCurrentTrack();
}

function setupZoomForCurrentTrack(){
  zoomCaps = null;
  const track = currentStream && currentStream.getVideoTracks()[0];
  if(track && track.getCapabilities){
    const caps = track.getCapabilities();
    if(caps.zoom){
      zoomCaps = caps.zoom;
    }
  }
  // 背面に超広角〜望遠の複数レンズがある機種: スライダーをレンズ切替+ネイティブズームに割当
  if(!usingFront && backDevices.length > 1){
    zoomMaxLabel.textContent = '望遠';
    zoomSlider.min = 0; zoomSlider.max = backDevices.length - 1; zoomSlider.step = 1;
    zoomSlider.value = currentDeviceIndex;
    updateZoomLabel(backDevices[currentDeviceIndex].label.replace(/back/i,'').trim() || `レンズ${currentDeviceIndex+1}`);
  } else if(zoomCaps){
    zoomMaxLabel.textContent = zoomCaps.max + 'x';
    zoomSlider.min = zoomCaps.min; zoomSlider.max = zoomCaps.max; zoomSlider.step = zoomCaps.step || 0.1;
    zoomSlider.value = track.getSettings().zoom || zoomCaps.min;
    updateZoomLabel((track.getSettings().zoom||1).toFixed(1)+'x');
  } else {
    zoomMaxLabel.textContent = '—';
    zoomSlider.min = 0; zoomSlider.max = 1; zoomSlider.step = 1; zoomSlider.value = 0;
    updateZoomLabel('1.0x');
  }
}
function updateZoomLabel(text){ zoomValue.textContent = text; }

zoomSlider.addEventListener('input', async ()=>{
  if(!usingFront && backDevices.length > 1 && !zoomCaps){
    // レンズ切替モード
    const idx = parseInt(zoomSlider.value, 10);
    if(idx !== currentDeviceIndex){
      await startCamera(idx);
    }
  } else if(zoomCaps){
    const track = currentStream.getVideoTracks()[0];
    const val = parseFloat(zoomSlider.value);
    try{
      await track.applyConstraints({ advanced:[{ zoom: val }] });
      updateZoomLabel(val.toFixed(1)+'x');
    }catch(e){ /* noop */ }
  }
});

flipBtn.addEventListener('click', async ()=>{
  usingFront = !usingFront;
  currentDeviceIndex = 0;
  await startCamera();
});

/* ============================================================
   3. フローティングウィンドウ: ドラッグ & リサイズ
============================================================ */
const bubble = document.getElementById('bubble');
function initBubbleDrag(){
  let dragging=false, startX=0, startY=0, startLeft=0, startTop=0;
  const rectInit = bubble.getBoundingClientRect();
  bubble.style.left = rectInit.left+'px';
  bubble.style.top  = rectInit.top+'px';
  bubble.style.right = 'auto';

  function pointerDown(e){
    if(e.target.id === 'resizeHandle') return;
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX; startY = p.clientY;
    const r = bubble.getBoundingClientRect();
    startLeft = r.left; startTop = r.top;
  }
  function pointerMove(e){
    if(!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - startX, dy = p.clientY - startY;
    let nl = startLeft+dx, nt = startTop+dy;
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    nl = Math.max(4, Math.min(window.innerWidth - w - 4, nl));
    nt = Math.max(4, Math.min(window.innerHeight - h - 4, nt));
    bubble.style.left = nl+'px';
    bubble.style.top  = nt+'px';
    e.preventDefault();
  }
  function pointerUp(){ dragging=false; }

  bubble.addEventListener('touchstart', pointerDown, {passive:true});
  bubble.addEventListener('touchmove', pointerMove, {passive:false});
  bubble.addEventListener('touchend', pointerUp);
  bubble.addEventListener('mousedown', pointerDown);
  window.addEventListener('mousemove', pointerMove);
  window.addEventListener('mouseup', pointerUp);
}

function initResize(){
  const handle = document.getElementById('resizeHandle');
  let resizing=false, startX=0, startY=0, startW=0, startH=0;
  function down(e){
    resizing = true;
    const p = e.touches ? e.touches[0] : e;
    startX=p.clientX; startY=p.clientY;
    startW = bubble.offsetWidth; startH = bubble.offsetHeight;
    e.stopPropagation();
  }
  function move(e){
    if(!resizing) return;
    const p = e.touches ? e.touches[0] : e;
    const d = Math.max(p.clientX-startX, p.clientY-startY);
    const size = Math.max(90, Math.min(280, startW + d));
    bubble.style.setProperty('--bw', size+'px');
    bubble.style.setProperty('--bh', size+'px');
    e.preventDefault();
  }
  function up(){ resizing=false; }
  handle.addEventListener('touchstart', down, {passive:true});
  handle.addEventListener('touchmove', move, {passive:false});
  handle.addEventListener('touchend', up);
  handle.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/* ============================================================
   4. 写真撮影(無音 / システムのシャッター音APIを使わないためサイレント)
============================================================ */
const snapCanvas = document.getElementById('snapCanvas');
function initShutter(){
  document.getElementById('shotBtn').addEventListener('click', takePhoto);
}
async function takePhoto(){
  const w = camVideo.videoWidth, h = camVideo.videoHeight;
  if(!w){ toast('カメラ起動中です'); return; }
  snapCanvas.width = w; snapCanvas.height = h;
  const ctx = snapCanvas.getContext('2d');
  if(usingFront){ ctx.translate(w,0); ctx.scale(-1,1); }
  ctx.drawImage(camVideo, 0, 0, w, h);
  snapCanvas.toBlob(async (blob)=>{
    await saveBlob(blob, `photo_${Date.now()}.jpg`, 'image/jpeg');
  }, 'image/jpeg', 0.92);
}

async function saveBlob(blob, filename, mime){
  const file = new File([blob], filename, {type:mime});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{
      await navigator.share({files:[file]});
      return;
    }catch(e){ /* キャンセル時はフォールバックしない */ if(e.name==='AbortError') return; }
  }
  // フォールバック: 新しいタブで開く(長押しで保存可能)
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  toast('保存しました(共有メニューが使えない端末ではダウンロードフォルダ/ファイルApp内を確認してください)');
}

/* ============================================================
   5. 動画録画
============================================================ */
let mediaRecorder = null;
let recordedChunks = [];
let recTimerInt = null;
let recSeconds = 0;
const recBtn = document.getElementById('recBtn');
const recIndicator = document.getElementById('recIndicator');
const recTimeEl = document.getElementById('recTime');

function initRecorder(){
  recBtn.addEventListener('click', ()=>{
    if(mediaRecorder && mediaRecorder.state === 'recording'){
      stopRecording();
    } else {
      startRecording();
    }
  });
}

function pickMimeType(){
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  for(const c of candidates){
    if(window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function startRecording(){
  if(!currentStream){ toast('カメラが起動していません'); return; }
  recordedChunks = [];
  const mime = pickMimeType();
  try{
    mediaRecorder = mime ? new MediaRecorder(currentStream, {mimeType:mime}) : new MediaRecorder(currentStream);
  }catch(e){
    toast('この端末では録画に対応していません');
    return;
  }
  mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size>0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  recBtn.classList.add('recording');
  recIndicator.classList.remove('hidden');
  recSeconds = 0; recTimeEl.textContent = '00:00';
  recTimerInt = setInterval(()=>{
    recSeconds++;
    const m = String(Math.floor(recSeconds/60)).padStart(2,'0');
    const s = String(recSeconds%60).padStart(2,'0');
    recTimeEl.textContent = `${m}:${s}`;
  }, 1000);
}

function stopRecording(){
  if(mediaRecorder && mediaRecorder.state==='recording'){
    mediaRecorder.stop();
  }
  recBtn.classList.remove('recording');
  recIndicator.classList.add('hidden');
  clearInterval(recTimerInt);
}

async function onRecordingStop(){
  const mime = mediaRecorder.mimeType || 'video/webm';
  const blob = new Blob(recordedChunks, {type:mime});
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  await saveBlob(blob, `video_${Date.now()}.${ext}`, mime);
}

/* ============================================================
   6. 内蔵ブラウザ
============================================================ */
function initBrowser(){
  const form = document.getElementById('urlForm');
  const input = document.getElementById('urlInput');
  const frame = document.getElementById('webFrame');
  const hint = document.getElementById('frameHint');
  const openExternal = document.getElementById('openExternal');
  const backBtn = document.getElementById('navBack');

  function normalize(raw){
    let v = raw.trim();
    if(!v) return null;
    if(/^https?:\/\//i.test(v)) return v;
    if(/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v)) return 'https://'+v;
    return 'https://www.google.com/search?q=' + encodeURIComponent(v);
  }

  form.addEventListener('submit', e=>{
    e.preventDefault();
    const url = normalize(input.value);
    if(!url) return;
    hint.classList.add('hidden');
    frame.src = url;
    openExternal.href = url;
    input.value = url;
    // 埋め込み拒否サイトはonloadが発火しても中身が空のことがあるため、
    // 一定時間後にヒントを出す(検出は完全にはできないため目安表示)
    clearTimeout(initBrowser._hintTm);
    initBrowser._hintTm = setTimeout(()=> hint.classList.remove('hidden'), 3500);
  });

  frame.addEventListener('load', ()=>{
    clearTimeout(initBrowser._hintTm);
  });

  backBtn.addEventListener('click', ()=>{
    try{ frame.contentWindow.history.back(); }catch(e){}
  });
}
