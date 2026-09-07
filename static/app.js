const avatar=document.getElementById('ani-avatar');
const form=document.getElementById('chat-form');
const input=document.getElementById('message-input');
const history=document.getElementById('history');
const historySentinel=document.querySelector('.history-sentinel');
const player=document.getElementById('voice-player');
const statusPlayer=document.getElementById('status-player');
const contextMeter=document.getElementById('context-meter');
const contextMeterFill=contextMeter?.querySelector('.context-meter-fill');
const micButton=document.getElementById('mic-button');
const cameraButton=document.getElementById('camera-button');
const screenButton=document.getElementById('screen-button');
const installButton=document.getElementById('install-button');
const profilePicker=document.getElementById('profile-picker');
const phaseIndicator=document.getElementById('phase-indicator');
const phaseLabel=phaseIndicator.querySelector('.phase-label');
const phaseTime=phaseIndicator.querySelector('time');
const SESSION_GENERATION='4';
const MAX_SESSION_TURNS=12;
let currentProfile=localStorage.getItem('ani.profile')||'';
if(localStorage.getItem('ani.session.generation')!==SESSION_GENERATION){
localStorage.removeItem('ani.session');
localStorage.removeItem('ani.session.turns');
localStorage.setItem('ani.session.generation',SESSION_GENERATION);
}
let voiceEnabled=localStorage.getItem('ani.voice')!=='off';
let persona={display_name:'Ani',avatar:null,voice:null};
let selectedAvatarName='';
let deferredInstall=null;

function setEmotion(emotion='neutral'){
  [...avatar.classList].filter(x=>x.startsWith('emotion-')).forEach(x=>avatar.classList.remove(x));
  avatar.classList.add(`emotion-${emotion}`);
  window.aniAvatar?.setEmotion(emotion);
}
function bubble(text,who){
  const el=document.createElement('div');el.className=`bubble ${who}`;el.textContent=text;
  history.appendChild(el);history.scrollTop=history.scrollHeight;return el;
}
function isLandscapeLayout(){
  return window.matchMedia('(min-width:800px) and (orientation:landscape)').matches;
}
function bubbleLandscape(text,who){
  const el=document.createElement('div');el.className=`bubble ${who}`;el.textContent=text;
  history.appendChild(el);return el;
}
let landscapeScrollArmed=false;
function ensureLandscapeObserver(){
  if(landscapeScrollArmed||!isLandscapeLayout())return;
  landscapeScrollArmed=true;
  history.addEventListener('scroll',()=>{
    if(history.scrollTop<80)renderLandscapeHistoryBatch();
  },{passive:true});
}
function renderLandscapeHistoryBatch(){
  if(!landscapeHistory.length)return;
  const start=Math.max(0,landscapeHistoryIndex-LANDSCAPE_HISTORY_BATCH);
  if(start>=landscapeHistoryIndex)return;
  const previousHeight=history.scrollHeight;
  const batch=landscapeHistory.slice(start,landscapeHistoryIndex);
  const frag=document.createDocumentFragment();
  for(const item of batch){
    const el=document.createElement('div');el.className=`bubble ${item.who}`;el.textContent=item.text;
    frag.appendChild(el);
  }
  history.insertBefore(frag,historySentinel?historySentinel.nextSibling:history.firstChild);
  landscapeHistoryIndex=start;
  history.scrollTop+=history.scrollHeight-previousHeight;
}
function resetLandscapeHistory(){
  landscapeHistory=[];landscapeHistoryIndex=0;
  history.replaceChildren();
  if(historySentinel)history.appendChild(historySentinel);
}
function pushLandscapeMessage(text,who){
  landscapeHistory.push({text,who});
  landscapeHistoryIndex=landscapeHistory.length;
  const el=bubbleLandscape(text,who);
  const rendered=history.querySelectorAll('.bubble').length;
  if(rendered>LANDSCAPE_HISTORY_BATCH){
    const toRemove=rendered-LANDSCAPE_HISTORY_BATCH;
    const bubbles=history.querySelectorAll('.bubble');
    for(let i=0;i<toRemove;i++)bubbles[i].remove();
    landscapeHistoryIndex=landscapeHistory.length-LANDSCAPE_HISTORY_BATCH;
  }
  history.scrollTop=history.scrollHeight;
  return el;
}
window.__aniTestPush=(text,who)=>{if(isLandscapeLayout())pushLandscapeMessage(text,who);else bubble(text,who)};
Object.defineProperty(window,'__aniLandscapeIndex',{get:()=>landscapeHistoryIndex});
Object.defineProperty(window,'__aniLandscapeTotal',{get:()=>landscapeHistory.length});
const ENVELOPE_FPS=60;
const SILENT_WAV='data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
let audioEnvelope=[];
let mouthFrame=null;
let audioUnlocked=false;
let audioUnlockPromise=null;
let activeTurnId=0;
let activeTurnKey=null;
let aniTurnActive=false;
let chatController=null;
let ttsController=null;
let streamingSpeech=null;
let activeAssistantBubble=null;
let activeAudioUrl=null;
let turnTimingStarted=performance.now();
let lastAudioEndedAt=null;
let phaseStartedAt=performance.now();
let phaseClock=null;
let slowWakeTimer=null;
let slowWakeNoticeUsed=false;
let statusAudioUrl=null;
let statusController=null;
let statusNoticeToken=0;
let currentStatusKind=null;
let statusTurnKey=null;
let contextTokensUsed=0;
let contextTokensMax=65000;
refreshContextMeter();
const LANDSCAPE_HISTORY_BATCH=20;
let landscapeHistory=[];
let landscapeHistoryIndex=0;
const STATUS_PHRASES={
  compression:[
    'Excuse-moi, je range mes idées.',
    'Une seconde, je remets mes pensées dans le bon ordre.',
    'Attends-moi un instant, je classe nos souvenirs.',
  ],
  waking:[
    'Je me réveille. Après un bon café, ça ira mieux.',
    'Une petite seconde, mon cerveau démarre doucement.',
    'Je sors du brouillard. Le café imaginaire arrive.',
  ],
};
const lastStatusPhrase={};

function avatarName(){return selectedAvatarName||persona.display_name||'Ani'}
function updateAvatarIdentity(name=avatarName()){
  selectedAvatarName=(name||'Ani').trim()||'Ani';
  name=selectedAvatarName;
  const nameElement=document.querySelector('.topbar strong');
  if(nameElement)nameElement.textContent=selectedAvatarName;
  document.title=name;
  setPhase(phaseIndicator.dataset.phase||'idle');
}
function renderPhaseTime(){
  const seconds=Math.max(0,Math.floor((performance.now()-phaseStartedAt)/1000));
  phaseTime.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}
function setPhase(phase='idle'){
  const labels={idle:'Prête',transcription:'Transcription',llm:`${avatarName()} réfléchit`,answering:`${avatarName()} répond`,compression:`${avatarName()} organise ses souvenirs`};
  const changed=phaseIndicator.dataset.phase!==phase;
  phaseIndicator.dataset.phase=phase;phaseLabel.textContent=labels[phase]||phase;
  phaseIndicator.setAttribute('aria-label',labels[phase]||phase);
  if(!changed)return;
  phaseStartedAt=performance.now();renderPhaseTime();clearInterval(phaseClock);phaseClock=null;
  if(phase!=='idle')phaseClock=setInterval(renderPhaseTime,250);
}
function updateContextMeter(used,max){
  if(!contextMeterFill)return;
  contextTokensUsed=used;contextTokensMax=max;
  const pct=Math.min(100,Math.round((used/max)*100));
  contextMeterFill.style.width=`${pct}%`;
  contextMeter.setAttribute('aria-valuenow',String(pct));
  contextMeter.setAttribute('aria-label',`Contexte: ${used} / ${max} tokens (${pct}%)`);
  if(pct>90)contextMeterFill.style.background='#ff5a5a';
  else if(pct>70)contextMeterFill.style.background='#ffbd68';
  else contextMeterFill.style.background='var(--accent)';
}
function estimateContextTokens(){
  const turns=Math.max(0,Number.parseInt(localStorage.getItem(`ani.session.turns.${currentProfile}`)||'0',10)||0);
  const baseTokens=3000;
  const tokensPerTurn=1200;
  return Math.min(contextTokensMax,baseTokens+turns*tokensPerTurn);
}
function refreshContextMeter(){
  updateContextMeter(estimateContextTokens(),contextTokensMax);
}
function randomStatusPhrase(kind){
  const phrases=STATUS_PHRASES[kind]||[];
  if(!phrases.length)return '';
  let index=Math.floor(Math.random()*phrases.length);
  if(phrases.length>1&&index===lastStatusPhrase[kind])index=(index+1)%phrases.length;
  lastStatusPhrase[kind]=index;
  return phrases[index];
}
function stopStatusNotice(){
  statusNoticeToken++;currentStatusKind=null;
  if(statusTurnKey){fetch('/api/tts/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({turn_key:statusTurnKey}),keepalive:true}).catch(()=>{});statusTurnKey=null}
  statusController?.abort();statusController=null;statusPlayer.pause();statusPlayer.removeAttribute('src');statusPlayer.load();
  if(statusAudioUrl){URL.revokeObjectURL(statusAudioUrl);statusAudioUrl=null}
}
async function playStatusNotice(kind){
  if(!voiceEnabled)return;
  if(kind!=='compression'&&currentStatusKind)return;
  stopStatusNotice();currentStatusKind=kind;
  const token=++statusNoticeToken;
  statusTurnKey=`status-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  if(!audioUnlocked&&audioUnlockPromise)await audioUnlockPromise.catch(()=>{});
  if(token!==statusNoticeToken||!audioUnlocked||!voiceEnabled)return;
  const text=randomStatusPhrase(kind);if(!text)return;
  const controller=new AbortController();statusController=controller;
  try{
    const response=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,emotion:kind==='compression'?'curious':'neutral',turn_key:statusTurnKey,voice:persona.voice}),signal:controller.signal});
    if(!response.ok||token!==statusNoticeToken)return;
    const audioUrl=URL.createObjectURL(await response.blob());
    if(token!==statusNoticeToken){URL.revokeObjectURL(audioUrl);return}
    statusAudioUrl=audioUrl;statusPlayer.src=statusAudioUrl;
    await statusPlayer.play();
  }catch(error){if(error?.name!=='AbortError')console.warn('Annonce vocale indisponible',error)}
}

function reportAudioTiming(event,{turnKey=activeTurnKey,chunkSeq=0,durationMs=null,text='',detail=''}={}){
  const elapsedMs=Math.max(0,performance.now()-turnTimingStarted);
  const payload={event,turn_key:turnKey,chunk_seq:chunkSeq,elapsed_ms:elapsedMs,duration_ms:durationMs,text,detail};
  console.info('[ANI-TIMING]',payload);
  fetch('/api/audio/timing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:true}).catch(()=>{});
}

function unlockAudio(){
  if(!voiceEnabled||audioUnlocked)return;
  if(audioUnlockPromise)return audioUnlockPromise;
  for(const audio of [player,statusPlayer]){audio.src=SILENT_WAV;audio.volume=0}
  const attempts=[player.play(),statusPlayer.play()].filter(Boolean);
  audioUnlockPromise=Promise.all(attempts).then(()=>{
    for(const audio of [player,statusPlayer]){audio.pause();audio.currentTime=0;audio.volume=1}
    audioUnlocked=true;
  }).catch(error=>{
    for(const audio of [player,statusPlayer])audio.volume=1;
    console.warn('Déverrouillage audio refusé',error);
  }).finally(()=>{audioUnlockPromise=null});
  return audioUnlockPromise;
}

async function buildAudioEnvelope(blob){
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  if(!AudioContext)return [];
  const context=new AudioContext();
  try{
    const buffer=await context.decodeAudioData(await blob.arrayBuffer());
    const samples=buffer.getChannelData(0);
    const frameSize=Math.max(1,Math.floor(buffer.sampleRate/ENVELOPE_FPS));
    const envelope=new Float32Array(Math.ceil(samples.length/frameSize));
    for(let frame=0;frame<envelope.length;frame++){
      const start=frame*frameSize;const end=Math.min(samples.length,start+frameSize);
      let energy=0;
      for(let index=start;index<end;index++)energy+=samples[index]*samples[index];
      envelope[frame]=Math.sqrt(energy/Math.max(1,end-start));
    }
    return envelope;
  }catch(error){
    console.warn('Analyse labiale indisponible',error);
    return [];
  }finally{
    context.close();
  }
}

function stopLipSync(){
  if(mouthFrame)cancelAnimationFrame(mouthFrame);
  mouthFrame=null;
  audioEnvelope=[];
  window.aniAvatar?.setMouthOpen(0);
  avatar.classList.remove('speaking');
}

function startLipSync(envelope){
  audioEnvelope=envelope;
  const animate=()=>{
    if(player.paused||player.ended){stopLipSync();return}
    const frame=Math.floor(player.currentTime*ENVELOPE_FPS);
    const energy=audioEnvelope[frame]??0.025;
    const openness=Math.max(.16,Math.min(1.25,.16+energy*12));
    window.aniAvatar?.setMouthOpen(openness);
    mouthFrame=requestAnimationFrame(animate);
  };
  animate();
}

function cancelActiveAniTurn({removeBubble=false}={}){
  const turnId=activeTurnId;
  const turnKey=activeTurnKey;
  if(aniTurnActive&&turnKey)fetch('/api/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({turn_key:turnKey}),keepalive:true}).catch(()=>{});
  activeTurnId++;activeTurnKey=null;
  clearTimeout(slowWakeTimer);slowWakeTimer=null;stopStatusNotice();setPhase('idle');
  chatController?.abort();chatController=null;
  streamingSpeech?.cancel();streamingSpeech=null;
  ttsController?.abort();ttsController=null;
  player.pause();
  if(activeAudioUrl){URL.revokeObjectURL(activeAudioUrl);activeAudioUrl=null}
  player.removeAttribute('src');player.load();
  stopLipSync();setEmotion('neutral');
  if(removeBubble&&aniTurnActive&&activeAssistantBubble?.isConnected)activeAssistantBubble.remove();
  activeAssistantBubble=null;aniTurnActive=false;
}

function interruptAudioForBargeIn(){
  streamingSpeech?.cancel();streamingSpeech=null;
  ttsController?.abort();ttsController=null;
  stopStatusNotice();
  player.pause();
  if(activeAudioUrl){URL.revokeObjectURL(activeAudioUrl);activeAudioUrl=null}
  player.removeAttribute('src');player.load();
  stopLipSync();
}

async function fetchAudioChunk(text,emotion,instructions,turnId,chunkSeq){
  ttsController=new AbortController();
  const started=performance.now();
  reportAudioTiming('tts.fetch.start',{chunkSeq,text});
  try{
    const response=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,emotion,instructions,turn_key:activeTurnKey,chunk_seq:chunkSeq,voice:persona.voice}),signal:ttsController.signal});
    if(turnId!==activeTurnId)return null;
    if(!response.ok)throw new Error('Voix indisponible');
    const blob=await response.blob();
    reportAudioTiming('tts.fetch.done',{chunkSeq,text,durationMs:performance.now()-started,detail:`bytes=${blob.size}`});
    return blob;
  }catch(error){
    reportAudioTiming('tts.fetch.error',{chunkSeq,text,durationMs:performance.now()-started,detail:error?.message||String(error)});
    throw error;
  }
}

function waitForAudioStop(turnId){
  return new Promise(resolve=>{
    let settled=false;
    const finish=event=>{
      if(settled)return;
      const reachedEnd=event.type==='ended'||player.ended||(Number.isFinite(player.duration)&&player.duration>0&&player.currentTime>=player.duration-.05);
      settled=true;
      player.removeEventListener('ended',finish);player.removeEventListener('pause',finish);player.removeEventListener('error',finish);
      resolve(reachedEnd&&turnId===activeTurnId);
    };
    player.addEventListener('ended',finish);player.addEventListener('pause',finish);player.addEventListener('error',finish);
  });
}

async function playAudioChunk(item,turnId){
  const blob=item.blob;
  if(!blob||turnId!==activeTurnId)return false;
  stopStatusNotice();
  if(activeAudioUrl)URL.revokeObjectURL(activeAudioUrl);
  activeAudioUrl=URL.createObjectURL(blob);player.src=activeAudioUrl;player.dataset.turnId=String(turnId);
  const envelopePromise=buildAudioEnvelope(blob);
  const finished=waitForAudioStop(turnId);
  avatar.classList.add('speaking');
  reportAudioTiming('audio.play.request',{chunkSeq:item.chunkSeq,text:item.text});
  await player.play();
  if(turnId!==activeTurnId){player.pause();return false}
  const playStarted=performance.now();
  const gapMs=lastAudioEndedAt===null?null:Math.max(0,playStarted-lastAudioEndedAt);
  reportAudioTiming('audio.play.started',{chunkSeq:item.chunkSeq,text:item.text,durationMs:Number.isFinite(player.duration)?player.duration*1000:null,detail:gapMs===null?'first_chunk':`gap_ms=${gapMs.toFixed(1)}`});
  const envelope=await envelopePromise;
  if(turnId!==activeTurnId)return false;
  startLipSync(envelope);
  const reachedEnd=await finished;
  lastAudioEndedAt=performance.now();
  reportAudioTiming('audio.play.ended',{chunkSeq:item.chunkSeq,text:item.text,durationMs:Number.isFinite(player.duration)?player.duration*1000:null,detail:`reachedEnd=${reachedEnd} played_ms=${(lastAudioEndedAt-playStarted).toFixed(1)}`});
  return reachedEnd;
}

function createStreamingSpeech(turnId){
  const queue=[];
  let pendingAudio=null;
  let closed=false;
  let cancelled=false;
  let turnKey=null;
  let nextChunkSeq=1;
  let wake=null;
  const notify=()=>{if(wake){const resolve=wake;wake=null;resolve()}};
  const ensurePrefetch=()=>{
    if(cancelled||pendingAudio||!queue.length)return;
    const item=queue.shift();
    pendingAudio={
      item,
      promise:fetchAudioChunk(item.text,item.emotion,'',turnId,item.chunkSeq),
    };
    notify();
  };
  const take=async()=>{
    while(!cancelled){
      ensurePrefetch();
      if(pendingAudio)return pendingAudio;
      if(closed)return null;
      await new Promise(resolve=>{wake=resolve});
    }
    return null;
  };
  const run=async()=>{
    while(!cancelled&&turnId===activeTurnId){
      const next=await take();
      if(!next)return;
      let blob;
      try{
        blob=await next.promise;
      }catch(error){
        if(cancelled||turnId!==activeTurnId||error?.name==='AbortError')return;
        pendingAudio=null;
        reportAudioTiming('tts.fetch.skipped',{turnKey,chunkSeq:next.item.chunkSeq,text:next.item.text,detail:error?.message||String(error)});
        ensurePrefetch();
        continue;
      }
      if(cancelled||turnId!==activeTurnId)return;
      pendingAudio=null;
      ensurePrefetch();
      if(!await playAudioChunk({...next.item,blob},turnId))return;
    }
  };
  const done=run();
  done.catch(()=>{});
  return {
    push(text,emotion='neutral'){
      if(closed||cancelled||!text)return;
      const item={text,emotion,chunkSeq:nextChunkSeq++};
      queue.push(item);
      reportAudioTiming('speech.queued',{turnKey,chunkSeq:item.chunkSeq,text,detail:`queue=${queue.length}`});
      ensurePrefetch();notify();
    },
    close(){closed=true;notify()},
    setTurnKey(value){turnKey=value},
    cancel(){
      cancelled=true;closed=true;queue.length=0;ttsController?.abort();notify();
      if(turnKey)fetch('/api/tts/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({turn_key:turnKey}),keepalive:true}).catch(()=>{});
    },
    done,
  };
}

async function readNdjson(response,onEvent){
  if(!response.body)throw new Error('Streaming indisponible');
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let buffer='';
  while(true){
    const {value,done}=await reader.read();
    buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
    const lines=buffer.split('\n');buffer=lines.pop()||'';
    for(const line of lines){if(line.trim())await onEvent(JSON.parse(line))}
    if(done)break;
  }
  if(buffer.trim())await onEvent(JSON.parse(buffer));
}

function streamingDisplayText(text){
  return text
    .replace(/^\([^)]+\)\s*/,'')
    .replace(/\[[^\]]*\]/g,' ')
    .replace(/\[[^\]]*$/,'')
    .replace(/\s+/g,' ')
    .trim();
}
function sessionForNextTurn(){
  const sessionKey=`ani.session.${currentProfile}`;
  const turnsKey=`ani.session.turns.${currentProfile}`;
  let sessionId=localStorage.getItem(sessionKey);
  let turns=Math.max(0,Number.parseInt(localStorage.getItem(turnsKey)||'0',10)||0);
  if(sessionId&&turns>=MAX_SESSION_TURNS){
    localStorage.removeItem(sessionKey);
    localStorage.removeItem(turnsKey);
    sessionId=null;turns=0;
    refreshContextMeter();
  }
  return {sessionId,turnNumber:turns+1};
}
player.addEventListener('ended',stopLipSync);
player.addEventListener('pause',stopLipSync);
statusPlayer.addEventListener('ended',stopStatusNotice);

function motionForText(text=''){
  const normalized=text.toLowerCase();
  if(/\[(?:danse|dance|dansant)\]/.test(normalized))return 'dance';
  if(/\[(?:tourne|tourne sur elle-même|spin)\]/.test(normalized))return 'spin';
  if(/\[(?:saute|jump)\]/.test(normalized))return 'jump';
  if(/\[(?:se balance|balance|sway)\]/.test(normalized))return 'sway';
  if(/\[(?:taquine|tease)\]/.test(normalized))return 'tease';
  return null;
}
function showProfilePicker(){
  if(!profilePicker)return;
  profilePicker.hidden=false;
}
function selectProfile(profile){
  currentProfile=profile;
  localStorage.setItem('ani.profile',profile);
  if(profilePicker)profilePicker.hidden=true;
  refreshContextMeter();refreshModelSelector();refreshAvatarSelector();loadPersona().then(refreshVoiceSelector);
}
const modelSelector=document.getElementById('model-selector');
let modelCatalog=[];
async function refreshModelSelector(){
  if(!modelSelector)return;
  try{
    const response=await fetch('/api/models');
    if(response.ok)modelCatalog=(await response.json()).models||[];
  }catch(_){modelCatalog=[]}
  if(!modelCatalog.length)modelCatalog=[{id:'ani-gemma4:latest',vision:false}];
  modelSelector.replaceChildren(...modelCatalog.map(model=>{
    const option=document.createElement('option');
    option.value=model.id;
    option.textContent=model.vision?`${model.id} (vision)`:model.id;
    return option;
  }));
  const saved=localStorage.getItem(`ani.model.${currentProfile}`)||'';
  if(modelCatalog.some(model=>model.id===saved))modelSelector.value=saved;
  else if(saved)localStorage.removeItem(`ani.model.${currentProfile}`);
}
modelSelector?.addEventListener('change',()=>{
  if(modelSelector.value)localStorage.setItem(`ani.model.${currentProfile}`,modelSelector.value);
});
const avatarSelector=document.getElementById('avatar-selector');
const voiceSelector=document.getElementById('voice-selector');
const QWEN_VOICES=['Vivian','Serena','Chelsie','Cherry','Nuna','Sofia'];
async function refreshAvatarSelector(){
  if(!avatarSelector)return;
  let catalog=[];let personaMap={};
  try{
    const [modelsResponse,personaResponse]=await Promise.all([
      fetch('/api/avatar-models'),
      fetch(`/api/persona?profile=${encodeURIComponent(currentProfile)}`).catch(()=>null),
    ]);
    if(modelsResponse.ok)catalog=(await modelsResponse.json()).models||[];
    if(personaResponse&&personaResponse.ok){
      const data=await personaResponse.json();
      personaMap[data.avatar]=data.display_name;
    }
  }catch(_){catalog=[]}
  if(!catalog.length)catalog=[{id:'ani.vrm',type:'vrm',label:'ani.vrm'}];
  avatarSelector.replaceChildren(...catalog.map(model=>{
    const option=document.createElement('option');
    option.value=model.id;
    option.textContent=personaMap[model.id]||model.label;
    return option;
  }));
  const saved=localStorage.getItem(`ani.avatar.${currentProfile}`)||persona.avatar||catalog[0].id;
  if(catalog.some(model=>model.id===saved))avatarSelector.value=saved;
  else{
    localStorage.removeItem(`ani.avatar.${currentProfile}`);
    avatarSelector.value=catalog[0].id;
  }
  updateAvatarIdentity(avatarSelector.selectedOptions[0]?.textContent||persona.display_name);
}
avatarSelector?.addEventListener('change',()=>{
  if(!avatarSelector.value)return;
  localStorage.setItem(`ani.avatar.${currentProfile}`,avatarSelector.value);
  if(confirm('Changer d’avatar recharge la page. Continuer ?'))location.reload();
  else{refreshAvatarSelector()}
});
function refreshVoiceSelector(){
  if(!voiceSelector)return;
  voiceSelector.replaceChildren(...QWEN_VOICES.map(voice=>{
    const option=document.createElement('option');
    option.value=voice;option.textContent=voice;
    return option;
  }));
  const saved=localStorage.getItem(`ani.voice.${currentProfile}`)||'';
  const selected=QWEN_VOICES.includes(saved)?saved:(QWEN_VOICES.includes(persona.voice)?persona.voice:'Vivian');
  if(saved&&!QWEN_VOICES.includes(saved))localStorage.removeItem(`ani.voice.${currentProfile}`);
  voiceSelector.value=selected;
  persona.voice=selected;
}
voiceSelector?.addEventListener('change',()=>{
  if(!voiceSelector.value)return;
  localStorage.setItem(`ani.voice.${currentProfile}`,voiceSelector.value);
  persona.voice=voiceSelector.value;
  setEmotion('happy');
});
window.__aniAvatarFile=()=>localStorage.getItem(`ani.avatar.${currentProfile}`)||persona.avatar||'ani.vrm';
async function loadPersona(){
  if(!currentProfile)return;
  try{
    const response=await fetch(`/api/persona?profile=${encodeURIComponent(currentProfile)}`);
    if(response.ok)persona=await response.json();
    const savedVoice=localStorage.getItem(`ani.voice.${currentProfile}`);
    if(savedVoice&&QWEN_VOICES.includes(savedVoice))persona.voice=savedVoice;
  }catch(_){}
  updateAvatarIdentity(avatarSelector?.selectedOptions[0]?.textContent||persona.display_name);
}
loadPersona();
profilePicker?.querySelectorAll('[data-profile]').forEach(button=>{
  button.addEventListener('click',()=>selectProfile(button.dataset.profile));
});
if(!currentProfile)showProfilePicker();else{refreshModelSelector();refreshAvatarSelector();refreshVoiceSelector()}

let pendingImage=null;
let cameraView=null;
function setImagePreview(dataUrl){
  pendingImage=dataUrl;
  cameraButton?.classList.toggle('active',!!dataUrl);
  screenButton?.classList.toggle('active',!!dataUrl);
  const existing=document.getElementById('ani-image-preview');
  if(existing)existing.remove();
  if(!dataUrl)return;
  const preview=document.createElement('img');
  preview.id='ani-image-preview';
  preview.src=dataUrl;
  preview.alt='Image jointe';
  preview.addEventListener('click',()=>setImagePreview(null));
  history.appendChild(preview);history.scrollTop=history.scrollHeight;
}
function stopCameraView(){
  if(!cameraView)return;
  cameraView.stream.getTracks().forEach(track=>track.stop());
  cancelAnimationFrame(cameraView.frame);
  cameraView.overlay.remove();
  cameraView=null;
}
function startCameraView(){
  const overlay=document.createElement('div');
  overlay.id='ani-camera-view';
  const video=document.createElement('video');
  video.autoplay=true;video.playsInline=true;video.muted=true;
  const sendButton=document.createElement('button');
  sendButton.type='button';sendButton.textContent='Envoyer à Ani';
  const closeButton=document.createElement('button');
  closeButton.type='button';closeButton.textContent='Annuler';closeButton.className='ani-camera-cancel';
  overlay.append(video,sendButton,closeButton);
  document.body.appendChild(overlay);
  const context=document.createElement('canvas').getContext('2d');
  const draw=()=>{
    if(!cameraView)return;
    if(video.videoWidth){
      context.canvas.width=video.videoWidth;context.canvas.height=video.videoHeight;
      context.drawImage(video,0,0);
    }
    cameraView.frame=requestAnimationFrame(draw);
  };
  navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:1280}}}).then(stream=>{
    if(!overlay.isConnected){stream.getTracks().forEach(track=>track.stop());return}
    video.srcObject=stream;
    cameraView={stream,overlay,frame:0};
    video.play().catch(()=>{});
    draw();
  }).catch(error=>{
    overlay.remove();cameraView=null;
    bubble(error?.name==='NotAllowedError'?'Autorisation refusée.':'Caméra indisponible.','ani');
  });
  closeButton.addEventListener('click',()=>{stopCameraView()});
  sendButton.addEventListener('click',()=>{
    if(!cameraView)return;
    const width=context.canvas.width||1280,height=context.canvas.height||720;
    const out=document.createElement('canvas');out.width=width;out.height=height;
    out.getContext('2d').drawImage(context.canvas,0,0);
    playShutterFeedback();
    setImagePreview(out.toDataURL('image/jpeg',0.85));
    stopCameraView();
    if(!input.value.trim())input.value='Regarde-moi. ';
  });
}
cameraButton?.addEventListener('click',()=>{
  if(cameraView){stopCameraView();return}
  if(!navigator.mediaDevices?.getUserMedia){bubble('Caméra indisponible ici.','ani');return}
  startCameraView();
});
screenButton?.addEventListener('click',()=>{
  if(pendingImage){setImagePreview(null);return}
  captureAniCanvas();
});
function playShutterFeedback(){
  try{
    const AudioContext=window.AudioContext||window.webkitAudioContext;
    const context=new AudioContext();
    const click=context.createOscillator();
    const gain=context.createGain();
    click.type='square';click.frequency.setValueAtTime(1800,context.currentTime);
    click.frequency.exponentialRampToValueAtTime(500,context.currentTime+.08);
    gain.gain.setValueAtTime(.12,context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.1);
    click.connect(gain).connect(context.destination);
    click.start();click.stop(context.currentTime+.1);
    setTimeout(()=>context.close(),300);
  }catch(_){}
  const flash=document.createElement('div');
  flash.className='ani-capture-flash';
  document.body.appendChild(flash);
  setTimeout(()=>flash.remove(),320);
}
function captureAniCanvas(){
  const canvas=document.getElementById('avatar-canvas');
  if(!canvas){bubble('Capture indisponible.','ani');return}
  const out=document.createElement('canvas');
  const size=720;
  out.width=size;out.height=Math.round(size*canvas.clientHeight/canvas.clientWidth)||size;
  const context=out.getContext('2d');
  context.fillStyle='#100d13';
  context.fillRect(0,0,out.width,out.height);
  context.drawImage(canvas,0,0,out.width,out.height);
  playShutterFeedback();
  setImagePreview(out.toDataURL('image/jpeg',0.85));
  if(!input.value.trim())input.value='Regarde-toi. ';
}

form.addEventListener('submit',async event=>{
  event.preventDefault();const message=input.value.trim();if(!message)return;
  if(!currentProfile){showProfilePicker();return}
  cancelActiveAniTurn();const turnId=activeTurnId;aniTurnActive=true;
  turnTimingStarted=performance.now();lastAudioEndedAt=null;
  chatController=new AbortController();
  streamingSpeech=voiceEnabled?createStreamingSpeech(turnId):null;
  const sessionState=sessionForNextTurn();
  input.blur();unlockAudio();input.value='';setEmotion('curious');setPhase('llm');
  if(isLandscapeLayout())pushLandscapeMessage(message,'user');
  else{history.replaceChildren();bubble(message,'user')}
  let streamedText='';
  let completed=null;
  if(!slowWakeNoticeUsed)slowWakeTimer=setTimeout(()=>{
    if(aniTurnActive&&!streamedText&&phaseIndicator.dataset.phase==='llm'&&voiceEnabled){
      slowWakeNoticeUsed=true;playStatusNotice('waking');
    }
  },6000);
  try{
    const response=await fetch('/api/chat/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,session_id:sessionState.sessionId,turn_id:turnId,profile:currentProfile,model:localStorage.getItem(`ani.model.${currentProfile}`)||null,image:pendingImage,voice:persona.voice}),signal:chatController.signal});
    setImagePreview(null);
    if(turnId!==activeTurnId)return;
    if(!response.ok){const data=await response.json();throw new Error(data.detail||'Ani ne répond pas')}
    await readNdjson(response,async event=>{
      if(turnId!==activeTurnId)return;
      if(event.type==='start'){
        if(event.session_id){
          localStorage.setItem(`ani.session.${currentProfile}`,event.session_id);
          localStorage.setItem(`ani.session.turns.${currentProfile}`,String(sessionState.turnNumber));
          refreshContextMeter();
        }
        activeTurnKey=event.turn_key||null;
        streamingSpeech?.setTurnKey(activeTurnKey);
        return;
      }
      if(event.type==='delta'){
        clearTimeout(slowWakeTimer);slowWakeTimer=null;
        stopStatusNotice();
        setPhase('answering');
        streamedText+=event.text||'';
        const display=streamingDisplayText(streamedText);
        if(!activeAssistantBubble){
          if(isLandscapeLayout())activeAssistantBubble=pushLandscapeMessage(display,'ani');
          else activeAssistantBubble=bubble(display,'ani');
        }
        else activeAssistantBubble.textContent=display;
        history.scrollTop=history.scrollHeight;
        return;
      }
      if(event.type==='speech'){
        clearTimeout(slowWakeTimer);slowWakeTimer=null;stopStatusNotice();
        setEmotion(event.emotion||'neutral');
        streamingSpeech?.push(event.text,event.emotion);
        return;
      }
      if(event.type==='phase'&&event.phase==='compression'){
        clearTimeout(slowWakeTimer);slowWakeTimer=null;
        if(phaseIndicator.dataset.phase!=='compression'){setPhase('compression');playStatusNotice('compression')}
        return;
      }
      if(event.type==='phase'&&event.phase==='llm'){setPhase('llm');return}
      if(event.type==='phase'&&event.phase==='compacted'){setPhase('llm');stopStatusNotice();return}
      if(event.type==='error')throw new Error(event.message||'Ani ne répond pas');
      if(event.type==='complete')completed=event;
    });
    if(turnId!==activeTurnId)return;
    if(!completed)throw new Error('La réponse d’Ani a été interrompue.');
    if(completed.session_id)localStorage.setItem(`ani.session.${currentProfile}`,completed.session_id);
    clearTimeout(slowWakeTimer);slowWakeTimer=null;setEmotion(completed.emotion);setPhase('idle');
    refreshContextMeter();
    if(!activeAssistantBubble){
      const lastAni=[...history.querySelectorAll('.bubble.ani')].pop();
      if(lastAni&&streamedText&&completed.reply.replace(/\s+/g,' ').includes(
          streamingDisplayText(streamedText).slice(0,120).replace(/\s+/g,' '))){
        activeAssistantBubble=lastAni;
      }
    }
    if(!activeAssistantBubble){
      if(isLandscapeLayout())activeAssistantBubble=pushLandscapeMessage(completed.reply,'ani');
      else activeAssistantBubble=bubble(completed.reply,'ani');
    }
    else activeAssistantBubble.textContent=completed.reply;
    const replyMotion=completed.actions?.[0]?.name;if(replyMotion)window.aniAvatar?.playMotion(replyMotion);
    if(streamingSpeech){
      streamingSpeech.close();
      await streamingSpeech.done;
    }
    if(turnId===activeTurnId){aniTurnActive=false;activeAssistantBubble=null;streamingSpeech=null}
  }catch(error){
    if(error.name==='AbortError'||turnId!==activeTurnId)return;
    streamingSpeech?.cancel();streamingSpeech=null;
    player.pause();stopLipSync();
    clearTimeout(slowWakeTimer);slowWakeTimer=null;setPhase('idle');
    aniTurnActive=false;activeAssistantBubble=null;setEmotion('sad');
    if(isLandscapeLayout())pushLandscapeMessage(error.message,'ani');
    else bubble(error.message,'ani');
  }
});
document.addEventListener('keydown',event=>{
  if(event.key==='m'||event.key==='M'){
    voiceEnabled=!voiceEnabled;localStorage.setItem('ani.voice',voiceEnabled?'on':'off');
    if(!voiceEnabled){streamingSpeech?.cancel();player.pause();stopStatusNotice()}
  }
});

const microphoneErrorMessage=error=>{
  const code=error?.error||error?.name;
  if(code==='not-allowed'||code==='NotAllowedError')return 'Microphone refusé : autorise-le dans les réglages du navigateur.';
  if(code==='NotFoundError')return 'Aucun microphone utilisable n’a été trouvé.';
  if(code==='NotReadableError')return 'Le microphone est déjà utilisé par une autre application.';
  return error?.message||'La dictée vocale locale est momentanément indisponible.';
};
let microphoneMode=false;
let microphonePreferred=localStorage.getItem('ani.microphone')==='on';
let microphoneStarting=false;
let preferredGestureArmed=false;
let micStream=null;
let micContext=null;
let micAnalyser=null;
let micWaveform=null;
let micFrame=null;
let utteranceRecorder=null;
let utteranceChunks=[];
let speechStarted=0;
let silenceStarted=0;
let transcribing=false;
let discardRecording=false;
const END_OF_SPEECH_SILENCE_MS=1300;
const TRANSCRIPT_COMMIT_GRACE_MS=500;
const SPEECH_RMS_THRESHOLD=0.028;
const BARGE_IN_RMS_THRESHOLD=0.035;
const BARGE_IN_HOLD_MS=180;
let bargeInStarted=0;
let pendingTranscript='';
let transcriptCommitTimer=null;
let queuedTranscriptions=0;
let transcriptionQueue=Promise.resolve();

function recorderMimeType(){
  for(const type of ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus']){
    if(MediaRecorder.isTypeSupported(type))return type;
  }
  return '';
}

function scheduleTranscriptCommit(){
  clearTimeout(transcriptCommitTimer);transcriptCommitTimer=null;
  if(utteranceRecorder||queuedTranscriptions)return;
  transcriptCommitTimer=setTimeout(()=>{
    transcriptCommitTimer=null;
    if(utteranceRecorder||queuedTranscriptions)return;
    if(aniTurnActive){scheduleTranscriptCommit();return}
    const message=pendingTranscript.trim();pendingTranscript='';
    if(message){input.value=message;form.requestSubmit()}
  },TRANSCRIPT_COMMIT_GRACE_MS);
}

function appendTranscript(text){
  const fragment=text?.trim();if(!fragment)return;
  pendingTranscript=[pendingTranscript,fragment].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
}

async function transcribeUtterance(blob){
  const response=await fetch('/api/stt',{method:'POST',headers:{'content-type':blob.type||'application/octet-stream'},body:blob});
  const data=await response.json();
  if(!response.ok){if(response.status!==422)throw new Error(data.detail||'Transcription indisponible');return}
  appendTranscript(data.text);
}

function queueTranscription(blob){
  queuedTranscriptions++;transcribing=true;micButton.classList.add('transcribing');setPhase('transcription');
  transcriptionQueue=transcriptionQueue
    .then(()=>transcribeUtterance(blob))
    .catch(error=>bubble(microphoneErrorMessage(error),'ani'))
    .finally(()=>{
      queuedTranscriptions--;
      if(!queuedTranscriptions){transcribing=false;micButton.classList.remove('transcribing');if(!aniTurnActive)setPhase('idle')}
      scheduleTranscriptCommit();
    });
}

function startUtterance({preserveAniTurn=false}={}){
  if(!microphoneMode||utteranceRecorder)return;
  clearTimeout(transcriptCommitTimer);transcriptCommitTimer=null;
  if(aniTurnActive&&!preserveAniTurn)cancelActiveAniTurn({removeBubble:true});
  utteranceChunks=[];discardRecording=false;
  const mimeType=recorderMimeType();
  utteranceRecorder=new MediaRecorder(micStream,mimeType?{mimeType}:undefined);
  utteranceRecorder.ondataavailable=event=>{if(event.data.size)utteranceChunks.push(event.data)};
  utteranceRecorder.onstop=()=>{
    const type=utteranceRecorder?.mimeType||mimeType||'application/octet-stream';
    const blob=new Blob(utteranceChunks,{type});
    utteranceRecorder=null;utteranceChunks=[];
    if(!discardRecording&&blob.size>0)queueTranscription(blob);
  };
  speechStarted=performance.now();silenceStarted=0;
  utteranceRecorder.start(200);
}

function monitorVoiceActivity(){
  if(!microphoneMode)return;
  micAnalyser.getByteTimeDomainData(micWaveform);
  let energy=0;
  for(const sample of micWaveform){const value=(sample-128)/128;energy+=value*value}
  const rms=Math.sqrt(energy/micWaveform.length);
  window.__aniMicRms=rms;
  const now=performance.now();
  const assistantAudioPlaying=(!player.paused&&!player.ended)||(!statusPlayer.paused&&!statusPlayer.ended);
  if(assistantAudioPlaying){
    silenceStarted=0;
    if(utteranceRecorder?.state==='recording'){
      discardRecording=true;utteranceRecorder.stop();
    }
    if(rms>BARGE_IN_RMS_THRESHOLD){
      if(!bargeInStarted)bargeInStarted=now;
      else if(now-bargeInStarted>=BARGE_IN_HOLD_MS){
        bargeInStarted=0;interruptAudioForBargeIn();startUtterance({preserveAniTurn:true});
      }
    }else bargeInStarted=0;
    micFrame=requestAnimationFrame(monitorVoiceActivity);return;
  }
  bargeInStarted=0;
  if(rms>SPEECH_RMS_THRESHOLD){
    silenceStarted=0;
    if(!utteranceRecorder)startUtterance();
  }else if(utteranceRecorder?.state==='recording'&&now-speechStarted>400){
    if(!silenceStarted)silenceStarted=now;
    if(now-silenceStarted>END_OF_SPEECH_SILENCE_MS)utteranceRecorder.stop();
  }
  if(utteranceRecorder?.state==='recording'&&now-speechStarted>20000)utteranceRecorder.stop();
  micFrame=requestAnimationFrame(monitorVoiceActivity);
}

async function startMicrophoneMode(){
  if(microphoneMode||microphoneStarting)return;
  microphoneStarting=true;
  try{
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone refusé : ouvre Ani avec une adresse HTTPS sécurisée.');
    if(!window.MediaRecorder)throw new Error('Enregistrement audio indisponible dans ce navigateur.');
    unlockAudio();
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const AudioContext=window.AudioContext||window.webkitAudioContext;
    micContext=new AudioContext();
    await micContext.resume();
    const source=micContext.createMediaStreamSource(micStream);
    micAnalyser=micContext.createAnalyser();micAnalyser.fftSize=512;
    micWaveform=new Uint8Array(micAnalyser.fftSize);source.connect(micAnalyser);
    microphoneMode=true;microphonePreferred=true;localStorage.setItem('ani.microphone','on');
    micStream.getTracks().forEach(track=>track.addEventListener('ended',()=>{
      if(microphoneMode){stopMicrophoneMode(false);armPreferredMicrophone()}
    },{once:true}));
    micButton.classList.remove('needs-gesture');
    micButton.classList.add('listening');micButton.setAttribute('aria-pressed','true');
    micButton.setAttribute('aria-label','Arrêter l’écoute continue');
    monitorVoiceActivity();
  }finally{microphoneStarting=false}
}

function stopMicrophoneMode(remember=false){
  microphoneMode=false;discardRecording=true;
  clearTimeout(transcriptCommitTimer);transcriptCommitTimer=null;pendingTranscript='';
  if(remember){microphonePreferred=false;localStorage.setItem('ani.microphone','off')}
  if(micFrame)cancelAnimationFrame(micFrame);micFrame=null;
  if(utteranceRecorder?.state==='recording')utteranceRecorder.stop();
  micStream?.getTracks().forEach(track=>track.stop());micStream=null;
  micContext?.close();micContext=null;
  micButton.classList.remove('listening','transcribing');micButton.setAttribute('aria-pressed','false');
  micButton.setAttribute('aria-label','Activer l’écoute continue');
}

async function resumePreferredMicrophone(){
  preferredGestureArmed=false;micButton.classList.remove('needs-gesture');
  if(!microphonePreferred||microphoneMode)return;
  try{await startMicrophoneMode()}
  catch(error){bubble(microphoneErrorMessage(error),'ani');armPreferredMicrophone()}
}

function armPreferredMicrophone(){
  if(!microphonePreferred||microphoneMode||microphoneStarting||preferredGestureArmed)return;
  preferredGestureArmed=true;micButton.classList.add('needs-gesture');
  micButton.setAttribute('aria-label','Toucher l’écran pour réactiver le microphone');
  document.addEventListener('pointerdown',resumePreferredMicrophone,{once:true,capture:true});
}

micButton.setAttribute('aria-pressed','false');
micButton.addEventListener('click',async()=>{
  if(microphoneMode){stopMicrophoneMode(true);return}
  try{await startMicrophoneMode()}
  catch(error){stopMicrophoneMode(false);bubble(microphoneErrorMessage(error),'ani')}
});
armPreferredMicrophone();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)armPreferredMicrophone()});

window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstall=event;installButton.hidden=false});
installButton.addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;installButton.hidden=true});

function blink(){avatar.classList.add('blink');setTimeout(()=>avatar.classList.remove('blink'),130);setTimeout(blink,2400+Math.random()*4200)}setTimeout(blink,1800);
ensureLandscapeObserver();
window.addEventListener('resize',ensureLandscapeObserver);
