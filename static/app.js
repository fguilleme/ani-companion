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
function showSpeech(text){speech.textContent=text.replace(/^\([^)]+\)\s*/,'');speech.hidden=false;clearTimeout(showSpeech.timer);showSpeech.timer=setTimeout(()=>speech.hidden=true,9000)}
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
  startLipSync(await envelopePromise);
}
player.addEventListener('ended',stopLipSync);
player.addEventListener('pause',stopLipSync);

form.addEventListener('submit',async event=>{
  event.preventDefault();const message=input.value.trim();if(!message)return;
  input.blur();unlockAudio();input.value='';bubble(message,'user');thinking.hidden=false;setEmotion('curious');
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,session_id:localStorage.getItem('ani.session')})});
    const data=await response.json();if(!response.ok)throw new Error(data.detail||'Ani ne répond pas');
    if(data.session_id)localStorage.setItem('ani.session',data.session_id);
    thinking.hidden=true;setEmotion(data.emotion);bubble(data.reply,'ani');showSpeech(data.reply);
    await speak(data.reply,data.emotion);
  }catch(error){thinking.hidden=true;setEmotion('sad');bubble(error.message,'ani')}
});
voiceToggle.addEventListener('click',()=>{voiceEnabled=!voiceEnabled;localStorage.setItem('ani.voice',voiceEnabled?'on':'off');voiceToggle.classList.toggle('active',voiceEnabled);voiceToggle.setAttribute('aria-pressed',String(voiceEnabled));if(!voiceEnabled)player.pause()});

const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
const microphoneErrorMessage=error=>{
  const code=error?.error||error?.name;
  if(code==='not-allowed'||code==='service-not-allowed'||code==='NotAllowedError')return 'Microphone refusé : autorise-le dans les réglages du navigateur.';
  if(code==='audio-capture'||code==='NotFoundError')return 'Aucun microphone utilisable n’a été trouvé.';
  if(code==='NotReadableError')return 'Le microphone est déjà utilisé par une autre application.';
  if(code==='no-speech')return 'Je n’ai rien entendu. Réessaie en parlant plus près du micro.';
  return 'La dictée vocale est momentanément indisponible.';
};
async function requestMicrophonePermission(){
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone refusé : ouvre Ani avec une adresse HTTPS sécurisée.');
  const stream=await navigator.mediaDevices.getUserMedia({audio:true});
  stream.getTracks().forEach(track=>track.stop());
}
if(Recognition){
  const recognition=new Recognition();
  recognition.lang='fr-FR';
  recognition.interimResults=false;
  recognition.onstart=()=>micButton.classList.add('listening');
  recognition.onend=()=>micButton.classList.remove('listening');
  recognition.onerror=event=>{micButton.classList.remove('listening');bubble(microphoneErrorMessage(event),'ani')};
  recognition.onresult=event=>{input.value=event.results[0][0].transcript;form.requestSubmit()};
  micButton.addEventListener('click',async()=>{
    try{await requestMicrophonePermission();recognition.start()}
    catch(error){bubble(microphoneErrorMessage(error),'ani')}
  });
}else{micButton.addEventListener('click',()=>{input.placeholder='Dictée non disponible dans ce navigateur';input.focus()})}

window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstall=event;installButton.hidden=false});
installButton.addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;installButton.hidden=true});

function blink(){avatar.classList.add('blink');setTimeout(()=>avatar.classList.remove('blink'),130);setTimeout(blink,2400+Math.random()*4200)}setTimeout(blink,1800);
