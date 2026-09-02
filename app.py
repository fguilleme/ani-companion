import asyncio
import httpx
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata
import urllib.request

from fastapi import FastAPI, HTTPException, Request
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
HERMES_BIN = os.getenv('HERMES_BIN', '/home/francois/.hermes/hermes-agent/venv/bin/hermes')
QWEN_TTS_URL = os.getenv('ANI_QWEN_TTS_URL', 'http://127.0.0.1:15004/v1/audio/speech')
QWEN_TTS_VOICE = os.getenv('ANI_QWEN_TTS_VOICE', 'Serena')
WHISPER_ASR_URL = os.getenv('ANI_WHISPER_ASR_URL', 'http://127.0.0.1:9002/asr')
CHAT_TIMEOUT_SECONDS = int(os.getenv('ANI_CHAT_TIMEOUT_SECONDS', '300'))
ANSI_RE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
SESSION_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
RUN_SEMAPHORE = asyncio.Semaphore(2)
ACTIVE_CHAT_PROCESSES: dict[int, asyncio.subprocess.Process] = {}
ACTIVE_TTS_TASKS: dict[int, asyncio.Task] = {}

app = FastAPI(title='Ani Companion', docs_url=None, redoc_url=None)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    session_id: str | None = Field(default=None, max_length=160)
    turn_id: int = Field(default=0, ge=0)


class CancelRequest(BaseModel):
    turn_id: int = Field(ge=0)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    emotion: str = Field(default='neutral', max_length=24)
    turn_id: int = Field(default=0, ge=0)
    instructions: str = Field(default='', max_length=1000)


@app.middleware('http')
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Permissions-Policy'] = 'camera=(), geolocation=(), microphone=(self)'
    return response


@app.get('/api/health')
def health():
    return {'status': 'ready', 'companion': 'Ani'}


def parse_hermes_output(raw: str) -> tuple[str, str | None]:
    clean = ANSI_RE.sub('', raw).replace('\r', '')
    quiet_match = re.search(r'^session_id:\s+(\S+)\s*$', clean, re.MULTILINE | re.IGNORECASE)
    footer_match = re.search(r'^Session:\s+(\S+)', clean, re.MULTILINE)
    session_match = quiet_match or footer_match
    session_id = session_match.group(1) if session_match else None
    clean = re.sub(r'^session_id:\s+\S+\s*\n?', '', clean, count=1, flags=re.IGNORECASE)
    boxed = re.search(r'^╭[^\n]*\n(?P<reply>.*?)\n╰[^\n]*$', clean, re.MULTILINE | re.DOTALL)
    if boxed:
        reply = boxed.group('reply').strip()
    else:
        reply = re.split(r'^Session:\s+\S+', clean, maxsplit=1, flags=re.MULTILINE)[0].strip()
        reply = re.sub(r'^Query:.*?\n(?:Initializing agent\.\.\.\n)?', '', reply, flags=re.DOTALL).strip()
    return reply, session_id


def classify_emotion(text: str) -> str:
    lowered = text.casefold()
    if any(word in lowered for word in ('triste', 'désolée', 'désolé', 'peine', 'malheureuse', '[soupir]', '[pleure]')):
        return 'sad'
    if any(word in lowered for word in ('assez', 'harsh', 'damn', 'agacée', 'énervée', '[fronce les sourcils]')):
        return 'annoyed'
    if any(word in lowered for word in ('timide', 'rougis', 'rougit', 'mignon', '[rougit]')):
        return 'shy'
    if '?' in text or any(word in lowered for word in ('curieuse', 'intriguée', 'intéressant', 'wild', '[penche la tête]')):
        return 'curious'
    if any(word in lowered for word in ('adorable', 'j’adore', "j'adore", 'heureuse', 'contente', 'cute', 'trop bien', '[sourit]', '[rit]', '[rire]')) or '!' in text:
        return 'happy'
    return 'neutral'


def voice_settings(emotion: str) -> dict[str, str]:
    return {
        'happy': {'rate': '+8%', 'pitch': '+10Hz'},
        'curious': {'rate': '+3%', 'pitch': '+6Hz'},
        'shy': {'rate': '-4%', 'pitch': '+3Hz'},
        'sad': {'rate': '-12%', 'pitch': '-8Hz'},
        'annoyed': {'rate': '+5%', 'pitch': '-5Hz'},
        'neutral': {'rate': '+0%', 'pitch': '+0Hz'},
    }.get(emotion, {'rate': '+0%', 'pitch': '+0Hz'})


def build_hermes_command(session_id: str | None = None) -> list[str]:
    command = [
        HERMES_BIN,
        'chat',
        '--source',
        'ani-pwa',
        '--run-budget',
        '120',
    ]
    if session_id:
        if not SESSION_RE.fullmatch(session_id):
            raise ValueError('Invalid session id')
        command.extend(['--resume', session_id, '--no-restore-cwd'])
    command.extend(['--query-file', '-'])
    return command


@app.post('/api/chat')
async def chat(payload: ChatRequest):
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail='Le message est vide.')
    try:
        command = build_hermes_command(payload.session_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    async with RUN_SEMAPHORE:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, 'HERMES_HOME': '/home/francois/.hermes/profiles/ani'},
        )
        ACTIVE_CHAT_PROCESSES[payload.turn_id] = process
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(message.encode('utf-8')),
                timeout=CHAT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise HTTPException(status_code=504, detail='Ani met trop longtemps à répondre.')
        except asyncio.CancelledError:
            if process.returncode is None:
                process.terminate()
                await process.wait()
            raise
        finally:
            if ACTIVE_CHAT_PROCESSES.get(payload.turn_id) is process:
                ACTIVE_CHAT_PROCESSES.pop(payload.turn_id, None)

    if process.returncode != 0:
        error = stderr.decode('utf-8', errors='replace').strip()
        raise HTTPException(status_code=502, detail=f'Réponse Hermes indisponible: {error[-240:]}')
    reply, session_id = parse_hermes_output(stdout.decode('utf-8', errors='replace'))
    if not reply:
        raise HTTPException(status_code=502, detail="Ani n'a produit aucune réponse.")
    return {'reply': reply, 'session_id': session_id or payload.session_id, 'emotion': classify_emotion(reply)}


@app.post('/api/cancel')
async def cancel(payload: CancelRequest):
    process = ACTIVE_CHAT_PROCESSES.pop(payload.turn_id, None)
    audio_task = ACTIVE_TTS_TASKS.pop(payload.turn_id, None)
    if audio_task and not audio_task.done():
        audio_task.cancel()
        await asyncio.gather(audio_task, return_exceptions=True)
    if process and process.returncode is None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
    return {'cancelled': process is not None or audio_task is not None}


def _delete_file(path: str):
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def build_qwen_tts_request(text: str, instructions: str = '') -> urllib.request.Request:
    payload = {
        'model': 'qwen-tts',
        'voice': QWEN_TTS_VOICE,
        'input': text,
        'response_format': 'wav',
        'temperature': 0.15,
        'top_p': 0.8,
    }
    if instructions:
        payload['instructions'] = instructions
    return urllib.request.Request(
        QWEN_TTS_URL,
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )


def _fetch_qwen_audio(text: str, instructions: str = '') -> bytes:
    with urllib.request.urlopen(build_qwen_tts_request(text, instructions), timeout=180) as response:
        audio = response.read()
    if not audio:
        raise RuntimeError('Qwen TTS returned empty audio')
    return audio


async def _fetch_qwen_audio_async(text: str, instructions: str = '') -> bytes:
    request = build_qwen_tts_request(text, instructions)
    assert isinstance(request.data, bytes)
    content = request.data
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(QWEN_TTS_URL, content=content, headers={'Content-Type': 'application/json'})
        response.raise_for_status()
    if not response.content:
        raise RuntimeError('Qwen TTS returned empty audio')
    return response.content


def prepare_spoken_text(text: str) -> str:
    spoken = re.sub(r'^\([^)]+\)\s*', '', text.strip())
    spoken = re.sub(r'\[[^\]]+\]', ' ', spoken)
    spoken = re.sub(r'(?:\.{2,}|…)', '. ', spoken)
    spoken = re.sub(r'([.!?])\s*\1+', r'\1', spoken)
    spoken = ''.join(char for char in spoken if unicodedata.category(char) != 'So')
    spoken = re.sub(r'\s+([,.!?])', r'\1', spoken)
    return re.sub(r'\s+', ' ', spoken).strip()


def split_spoken_chunks(text: str, max_chars: int = 220) -> list[str]:
    sentences = [part.strip() for part in re.split(r'(?<=[.!?])\s+', text) if part.strip()]
    chunks: list[str] = []
    prefix = ''
    for sentence in sentences:
        if len(sentence) < 24 and not prefix:
            prefix = sentence
            continue
        if prefix:
            sentence = f'{prefix} {sentence}'
            prefix = ''
        while len(sentence) > max_chars:
            cut = sentence.rfind(' ', 0, max_chars + 1)
            if cut < max_chars // 2:
                cut = max_chars
            chunks.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            chunks.append(sentence)
    if prefix:
        if chunks and len(chunks[-1]) + len(prefix) + 1 <= max_chars:
            chunks[-1] = f'{chunks[-1]} {prefix}'
        else:
            chunks.append(prefix)
    return chunks


def extract_tts_instructions(text: str) -> str:
    directions = [part.strip() for part in re.findall(r'\[([^\]]+)\]', text) if part.strip()]
    if not directions:
        return ''
    return 'Interprète naturellement les indications suivantes sans les prononcer : ' + ' ; '.join(directions) + '.'


@app.post('/api/tts/plan')
async def tts_plan(payload: TTSRequest):
    spoken = prepare_spoken_text(payload.text)
    if not spoken:
        raise HTTPException(status_code=422, detail='Aucun texte à prononcer.')
    return {
        'chunks': split_spoken_chunks(spoken),
        'instructions': payload.instructions or extract_tts_instructions(payload.text),
    }


async def transcribe_local_audio(audio: bytes, content_type: str) -> str:
    extension = {'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav'}.get(content_type, 'audio')
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            WHISPER_ASR_URL,
            params={'task': 'transcribe', 'language': 'fr', 'vad_filter': 'true', 'output': 'txt'},
            files={'audio_file': (f'ani.{extension}', audio, content_type)},
        )
        response.raise_for_status()
    return response.text.strip()


@app.post('/api/stt')
async def stt(request: Request):
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=422, detail='Enregistrement audio vide.')
    if len(audio) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail='Enregistrement audio trop volumineux.')
    content_type = request.headers.get('content-type', 'application/octet-stream').split(';', 1)[0]
    try:
        text = await transcribe_local_audio(audio, content_type)
    except Exception as exc:
        raise HTTPException(status_code=502, detail='La transcription locale est indisponible.') from exc
    if not text:
        raise HTTPException(status_code=422, detail="Je n'ai rien entendu.")
    return {'text': text}


@app.post('/api/tts')
async def tts(payload: TTSRequest, background_tasks: BackgroundTasks):
    spoken = prepare_spoken_text(payload.text)
    instructions = payload.instructions or extract_tts_instructions(payload.text)
    if not spoken:
        raise HTTPException(status_code=422, detail='Aucun texte à prononcer.')
    fd, path = tempfile.mkstemp(prefix='ani-', suffix='.wav')
    os.close(fd)
    audio_task = asyncio.create_task(_fetch_qwen_audio_async(spoken, instructions))
    ACTIVE_TTS_TASKS[payload.turn_id] = audio_task
    try:
        audio = await audio_task
        Path(path).write_bytes(audio)
    except asyncio.CancelledError:
        _delete_file(path)
        raise
    except Exception as exc:
        _delete_file(path)
        raise HTTPException(status_code=502, detail='La voix est momentanément indisponible.') from exc
    finally:
        if ACTIVE_TTS_TASKS.get(payload.turn_id) is audio_task:
            ACTIVE_TTS_TASKS.pop(payload.turn_id, None)
    background_tasks.add_task(_delete_file, path)
    return FileResponse(path, media_type='audio/wav', filename='ani.wav')


app.mount('/', StaticFiles(directory=STATIC, html=True), name='static')
