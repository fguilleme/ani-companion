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
}
function bubble(text,who){const el=document.createElement('div');el.className=`bubble ${who}`;el.textContent=text;history.appendChild(el);history.scrollTop=history.scrollHeight}
function showSpeech(text){speech.textContent=text.replace(/^\([^)]+\)\s*/,'');speech.hidden=false;clearTimeout(showSpeech.timer);showSpeech.timer=setTimeout(()=>speech.hidden=true,9000)}
let audioContext=null;
let analyser=null;
let waveform=null;
let mouthFrame=null;

function stopLipSync(){
  if(mouthFrame)cancelAnimationFrame(mouthFrame);
  mouthFrame=null;
  avatar.style.setProperty('--mouth-open','.12');
  avatar.classList.remove('speaking');
}

function startLipSync(){
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  if(!AudioContext)return;
  if(!audioContext){
    audioContext=new AudioContext();
    analyser=audioContext.createAnalyser();
    analyser.fftSize=256;
    waveform=new Uint8Array(analyser.fftSize);
    const source=audioContext.createMediaElementSource(player);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
  }
  audioContext.resume();
  const animate=()=>{
    if(player.paused||player.ended){stopLipSync();return}
    analyser.getByteTimeDomainData(waveform);
    let energy=0;
    for(const sample of waveform)energy+=Math.abs(sample-128);
    const openness=Math.max(.16,Math.min(1.25,energy/waveform.length/10));
    avatar.style.setProperty('--mouth-open',openness.toFixed(2));
    mouthFrame=requestAnimationFrame(animate);
  };
  animate();
}

async function speak(text,emotion){
  if(!voiceEnabled)return;
  const response=await fetch('/api/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,emotion})});
  if(!response.ok)throw new Error('Voix indisponible');
  if(player.src)URL.revokeObjectURL(player.src);
  player.src=URL.createObjectURL(await response.blob());
  avatar.classList.add('speaking');
  await player.play();
  startLipSync();
}
player.addEventListener('ended',stopLipSync);
player.addEventListener('pause',stopLipSync);

form.addEventListener('submit',async event=>{
  event.preventDefault();const message=input.value.trim();if(!message)return;
  input.value='';bubble(message,'user');thinking.hidden=false;setEmotion('curious');
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
if(Recognition){const recognition=new Recognition();recognition.lang='fr-FR';recognition.interimResults=false;recognition.onstart=()=>micButton.classList.add('listening');recognition.onend=()=>micButton.classList.remove('listening');recognition.onresult=event=>{input.value=event.results[0][0].transcript;form.requestSubmit()};micButton.addEventListener('click',()=>recognition.start())}else{micButton.addEventListener('click',()=>{input.placeholder='Dictée non disponible dans ce navigateur';input.focus()})}

window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstall=event;installButton.hidden=false});
installButton.addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;installButton.hidden=true});

function blink(){avatar.classList.add('blink');setTimeout(()=>avatar.classList.remove('blink'),130);setTimeout(blink,2400+Math.random()*4200)}setTimeout(blink,1800);
avatar.addEventListener('click',()=>setEmotion('happy'));
