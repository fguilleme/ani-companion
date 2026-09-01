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
function bubble(text,who){const el=document.createElement('div');el.className=`bubble ${who}`;el.textContent=text;history.appendChild(el);history.scrollTop=history.scrollHeight}
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

async function speak(text,emotion){
  if(!voiceEnabled)return;
  const response=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,emotion})});
  if(!response.ok)throw new Error('Voix indisponible');
  const blob=await response.blob();
  if(player.src)URL.revokeObjectURL(player.src);
  player.src=URL.createObjectURL(blob);
  const envelopePromise=buildAudioEnvelope(blob);
  avatar.classList.add('speaking');
  await player.play();
  showSpeech(text,player.duration);
  startLipSync(await envelopePromise);
}
player.addEventListener('ended',()=>{stopLipSync();hideSpeech()});
player.addEventListener('pause',stopLipSync);

form.addEventListener('submit',async event=>{
  event.preventDefault();const message=input.value.trim();if(!message)return;
  input.blur();unlockAudio();input.value='';bubble(message,'user');thinking.hidden=false;setEmotion('curious');
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,session_id:localStorage.getItem('ani.session')})});
    const data=await response.json();if(!response.ok)throw new Error(data.detail||'Ani ne répond pas');
    if(data.session_id)localStorage.setItem('ani.session',data.session_id);
    thinking.hidden=true;setEmotion(data.emotion);
    if(voiceEnabled)await speak(data.reply,data.emotion);else showSpeech(data.reply);
  }catch(error){thinking.hidden=true;setEmotion('sad');bubble(error.message,'ani')}
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

function recorderMimeType(){
  for(const type of ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus']){
    if(MediaRecorder.isTypeSupported(type))return type;
  }
  return '';
}

async function transcribeUtterance(blob){
  transcribing=true;micButton.classList.add('transcribing');
  try{
    const response=await fetch('/api/stt',{method:'POST',headers:{'content-type':blob.type||'application/octet-stream'},body:blob});
    const data=await response.json();
    if(!response.ok){if(response.status!==422)throw new Error(data.detail||'Transcription indisponible');return}
    if(data.text?.trim()){input.value=data.text.trim();form.requestSubmit()}
  }catch(error){bubble(microphoneErrorMessage(error),'ani')}
  finally{transcribing=false;micButton.classList.remove('transcribing')}
}

function startUtterance(){
  if(!microphoneMode||transcribing||utteranceRecorder)return;
  utteranceChunks=[];discardRecording=false;
  const mimeType=recorderMimeType();
  utteranceRecorder=new MediaRecorder(micStream,mimeType?{mimeType}:undefined);
  utteranceRecorder.ondataavailable=event=>{if(event.data.size)utteranceChunks.push(event.data)};
  utteranceRecorder.onstop=()=>{
    const type=utteranceRecorder?.mimeType||mimeType||'application/octet-stream';
    const blob=new Blob(utteranceChunks,{type});
    utteranceRecorder=null;utteranceChunks=[];
    if(!discardRecording&&blob.size>0)transcribeUtterance(blob);
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
  const now=performance.now();
  if(rms>0.028){
    silenceStarted=0;
    if(!utteranceRecorder&&!transcribing)startUtterance();
  }else if(utteranceRecorder?.state==='recording'&&now-speechStarted>400){
    if(!silenceStarted)silenceStarted=now;
    if(now-silenceStarted>850)utteranceRecorder.stop();
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
