const avatar=document.getElementById('ani-avatar');
const form=document.getElementById('chat-form');
const input=document.getElementById('message-input');
const history=document.getElementById('history');
const speech=document.getElementById('speech');
const thinking=document.getElementById('thinking');
const player=document.getElementById('voice-player');
const voiceToggle=document.getElementById('voice-toggle');
const micButton=document.getElementById('mic-button');
const installButton=document.getElementById('install-button');
let voiceEnabled=localStorage.getItem('ani.voice')!=='off';
let deferredInstall=null;
voiceToggle.classList.toggle('active',voiceEnabled);
voiceToggle.setAttribute('aria-pressed',String(voiceEnabled));

function setEmotion(emotion='neutral'){
  [...avatar.classList].filter(x=>x.startsWith('emotion-')).forEach(x=>avatar.classList.remove(x));
  avatar.classList.add(`emotion-${emotion}`);
  window.aniAvatar?.setEmotion(emotion);
}
function bubble(text,who,{collapsible=false}={}){
  const el=document.createElement('div');el.className=`bubble ${who}`;el.textContent=text;
  if(collapsible){
    el.classList.add('collapsible');el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-expanded','false');
    const toggle=()=>{const expanded=el.classList.toggle('expanded');el.setAttribute('aria-expanded',String(expanded));history.scrollTop=history.scrollHeight};
    el.addEventListener('click',toggle);
    el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle()}});
  }
  history.appendChild(el);history.scrollTop=history.scrollHeight;return el;
}
let speechAnimation=null;
function hideSpeech(){speechAnimation?.cancel();speechAnimation=null;speech.hidden=true}
function showSpeech(text,durationSeconds=0){
  const clean=text.replace(/^\([^)]+\)\s*/,'').replace(/\[[^\]]+\]/g,' ').replace(/\s+/g,' ').trim();
  const ticker=document.createElement('span');ticker.className='speech-line';ticker.textContent=clean;
  speech.replaceChildren(ticker);speech.hidden=false;speechAnimation?.cancel();
  requestAnimationFrame(()=>{
    if(ticker.scrollWidth<=speech.clientWidth){ticker.style.width='100%';ticker.style.textAlign='center';return}
    const distance=ticker.scrollWidth-speech.clientWidth+24;
    speechAnimation=ticker.animate(
      [{transform:'translateX(0)'},{transform:`translateX(-${distance}px)`}],
      {duration:Number.isFinite(durationSeconds)&&durationSeconds>0?Math.max(1000,durationSeconds*1000):Math.max(7000,distance*28),iterations:1,easing:'linear',fill:'forwards'},
    );
  });
}
const ENVELOPE_FPS=60;
const SILENT_WAV='data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
let audioEnvelope=[];
let mouthFrame=null;
let audioUnlocked=false;
let activeTurnId=0;
let aniTurnActive=false;
let chatController=null;
let ttsController=null;
let activeAssistantBubble=null;
let activeAudioUrl=null;

function unlockAudio(){
  if(!voiceEnabled||audioUnlocked)return;
  player.src=SILENT_WAV;
  player.volume=0;
  const attempt=player.play();
  if(attempt)attempt.then(()=>{
    player.pause();player.currentTime=0;player.volume=1;audioUnlocked=true;
  }).catch(error=>{player.volume=1;console.warn('Déverrouillage audio refusé',error)});
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
  if(aniTurnActive)fetch('/api/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({turn_id:turnId}),keepalive:true}).catch(()=>{});
  activeTurnId++;
  chatController?.abort();chatController=null;
  ttsController?.abort();ttsController=null;
  player.pause();
  if(activeAudioUrl){URL.revokeObjectURL(activeAudioUrl);activeAudioUrl=null}
  player.removeAttribute('src');player.load();
  hideSpeech();stopLipSync();thinking.hidden=true;setEmotion('neutral');
  if(removeBubble&&aniTurnActive&&activeAssistantBubble?.isConnected)activeAssistantBubble.remove();
  activeAssistantBubble=null;aniTurnActive=false;
}

async function fetchAudioChunk(text,emotion,instructions,turnId){
  ttsController=new AbortController();
  const response=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,emotion,instructions,turn_id:turnId}),signal:ttsController.signal});
  if(turnId!==activeTurnId)return null;
  if(!response.ok)throw new Error('Voix indisponible');
  return response.blob();
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

async function speak(text,emotion,turnId){
  if(!voiceEnabled)return;
  ttsController=new AbortController();
  const planResponse=await fetch('/api/tts/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,emotion,turn_id:turnId}),signal:ttsController.signal});
  if(turnId!==activeTurnId)return;
  if(!planResponse.ok)throw new Error('Voix indisponible');
  const plan=await planResponse.json();
  const chunks=plan.chunks||[];
  if(!chunks.length)throw new Error('Voix indisponible');
  let pendingAudio=fetchAudioChunk(chunks[0],emotion,plan.instructions,turnId);
  for(let index=0;index<chunks.length;index++){
    const blob=await pendingAudio;
    if(!blob||turnId!==activeTurnId)return;
    if(index+1<chunks.length)pendingAudio=fetchAudioChunk(chunks[index+1],emotion,plan.instructions,turnId);
    else pendingAudio=null;
    if(activeAudioUrl)URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl=URL.createObjectURL(blob);player.src=activeAudioUrl;player.dataset.turnId=String(turnId);
    const envelopePromise=buildAudioEnvelope(blob);
    const finished=waitForAudioStop(turnId);
    avatar.classList.add('speaking');
    await player.play();
    if(turnId!==activeTurnId){player.pause();return}
    showSpeech(chunks[index],player.duration);
    const envelope=await envelopePromise;
    if(turnId!==activeTurnId)return;
    startLipSync(envelope);
    if(!await finished)return;
  }
  hideSpeech();aniTurnActive=false;activeAssistantBubble=null;
}
player.addEventListener('ended',()=>{stopLipSync();hideSpeech()});
player.addEventListener('pause',stopLipSync);

function motionForText(text=''){
  const normalized=text.toLowerCase();
  if(/\[(?:danse|dance|dansant)\]/.test(normalized))return 'dance';
  if(/\[(?:tourne|tourne sur elle-même|spin)\]/.test(normalized))return 'spin';
  if(/\[(?:saute|jump)\]/.test(normalized))return 'jump';
  if(/\[(?:se balance|balance|sway)\]/.test(normalized))return 'sway';
  if(/\[(?:taquine|tease)\]/.test(normalized))return 'tease';
  return null;
}

form.addEventListener('submit',async event=>{
  event.preventDefault();const message=input.value.trim();if(!message)return;
  cancelActiveAniTurn();const turnId=activeTurnId;aniTurnActive=true;
  chatController=new AbortController();
  input.blur();unlockAudio();input.value='';bubble(message,'user');thinking.hidden=false;setEmotion('curious');
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,session_id:localStorage.getItem('ani.session'),turn_id:turnId}),signal:chatController.signal});
    if(turnId!==activeTurnId)return;
    const data=await response.json();if(!response.ok)throw new Error(data.detail||'Ani ne répond pas');
    if(turnId!==activeTurnId)return;
    if(data.session_id)localStorage.setItem('ani.session',data.session_id);
    thinking.hidden=true;setEmotion(data.emotion);
    const replyMotion=motionForText(data.reply);if(replyMotion)window.aniAvatar?.playMotion(replyMotion);
    activeAssistantBubble=bubble(data.reply,'ani',{collapsible:true});
    if(voiceEnabled)await speak(data.reply,data.emotion,turnId);
    else{showSpeech(data.reply);aniTurnActive=false;activeAssistantBubble=null}
  }catch(error){
    if(error.name==='AbortError'||turnId!==activeTurnId)return;
    thinking.hidden=true;aniTurnActive=false;activeAssistantBubble=null;setEmotion('sad');bubble(error.message,'ani');
  }
});
voiceToggle.addEventListener('click',()=>{voiceEnabled=!voiceEnabled;localStorage.setItem('ani.voice',voiceEnabled?'on':'off');voiceToggle.classList.toggle('active',voiceEnabled);voiceToggle.setAttribute('aria-pressed',String(voiceEnabled));if(!voiceEnabled)player.pause()});

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
  queuedTranscriptions++;transcribing=true;micButton.classList.add('transcribing');
  transcriptionQueue=transcriptionQueue
    .then(()=>transcribeUtterance(blob))
    .catch(error=>bubble(microphoneErrorMessage(error),'ani'))
    .finally(()=>{
      queuedTranscriptions--;
      if(!queuedTranscriptions){transcribing=false;micButton.classList.remove('transcribing')}
      scheduleTranscriptCommit();
    });
}

function startUtterance(){
  if(!microphoneMode||utteranceRecorder)return;
  clearTimeout(transcriptCommitTimer);transcriptCommitTimer=null;
  if(aniTurnActive)cancelActiveAniTurn({removeBubble:true});
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
  if(!player.paused&&!player.ended){
    silenceStarted=0;
    if(utteranceRecorder?.state==='recording'){
      discardRecording=true;utteranceRecorder.stop();
    }
    micFrame=requestAnimationFrame(monitorVoiceActivity);return;
  }
  micAnalyser.getByteTimeDomainData(micWaveform);
  let energy=0;
  for(const sample of micWaveform){const value=(sample-128)/128;energy+=value*value}
  const rms=Math.sqrt(energy/micWaveform.length);
  const now=performance.now();
  if(rms>0.028){
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
