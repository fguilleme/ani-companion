import asyncio
import base64
import binascii
from collections import deque
from contextlib import asynccontextmanager
import httpx
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import secrets
import signal
import struct
import tempfile
import time
import unicodedata
import urllib.request
import wave

from fastapi import FastAPI, HTTPException, Request
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
HERMES_BIN = os.getenv('HERMES_BIN', '/home/francois/.hermes/hermes-agent/venv/bin/hermes')
HERMES_PYTHON = os.getenv('HERMES_PYTHON', str(Path(HERMES_BIN).with_name('python')))
HERMES_AGENT_ROOT = os.getenv('HERMES_AGENT_ROOT', str(Path(HERMES_BIN).resolve().parents[2]))
HERMES_HOME = os.getenv('HERMES_HOME', '/home/francois/.hermes/profiles/ani')
HERMES_PROFILES = {
    'francois': os.getenv('ANI_HERMES_HOME_FRANCOIS', '/home/francois/.hermes/profiles/ani'),
    'salome': os.getenv('ANI_HERMES_HOME_SALOME', '/home/francois/.hermes/profiles/ani-salome'),
}
DEFAULT_PROFILE = 'francois'
HERMES_MODEL = os.getenv('ANI_HERMES_MODEL', 'ani-gemma4:latest')
HERMES_PROVIDER = os.getenv('ANI_HERMES_PROVIDER', 'custom')
HERMES_TUI_TOOLSETS = os.getenv('ANI_HERMES_TOOLSETS', 'memory')
QWEN_TTS_URL = os.getenv('ANI_QWEN_TTS_URL', 'http://127.0.0.1:15004/v1/audio/speech')
QWEN_TTS_VOICE = os.getenv('ANI_QWEN_TTS_VOICE', 'Serena')
WHISPER_ASR_URL = os.getenv('ANI_WHISPER_ASR_URL', 'http://127.0.0.1:9002/asr')
CHAT_TIMEOUT_SECONDS = max(1, int(os.getenv('ANI_CHAT_TIMEOUT_SECONDS', '900')))
ANSI_RE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
SESSION_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
RUN_SEMAPHORE = asyncio.Semaphore(2)
ACTIVE_CHAT_PROCESSES: dict[str, asyncio.subprocess.Process] = {}
ACTIVE_TTS_TASKS: dict[str, asyncio.Task] = {}
logger = logging.getLogger('ani-companion')
logger.setLevel(logging.INFO)
if not logger.handlers:
    timing_handler = logging.StreamHandler()
    timing_handler.setFormatter(logging.Formatter('%(levelname)s %(name)s %(message)s'))
    logger.addHandler(timing_handler)
logger.propagate = False

app = FastAPI(title='Ani Companion', docs_url=None, redoc_url=None)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    session_id: str | None = Field(default=None, max_length=160)
    turn_id: int = Field(default=0, ge=0)
    profile: str = Field(default=DEFAULT_PROFILE, max_length=32)
    model: str | None = Field(default=None, max_length=160)
    image: str | None = Field(default=None, max_length=15_000_000)


_IMAGE_MIME_EXTENSIONS = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}
_IMAGE_MAGIC = (
    (b'\x89PNG\r\n\x1a\n', '.png'),
    (b'\xff\xd8\xff', '.jpg'),
    (b'RIFF', '.webp'),
)
VISION_IMAGE_MAX_BYTES = 10 * 1024 * 1024
_DATA_URL_RE = re.compile(r'^data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$')


def decode_image_data_url(data_url: str) -> tuple[str, str]:
    """Validate a base64 image data URL and stage it in a private temp file for Hermes.

    Returns (path, extension); raises HTTPException on any invalid input. Size-capped, magic-byte
    checked, unpredictably named; the caller deletes the file after the turn."""
    match = _DATA_URL_RE.fullmatch(data_url or '')
    if not match:
        raise HTTPException(status_code=422, detail='Image invalide.')
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail='Image invalide.') from exc
    if not raw:
        raise HTTPException(status_code=422, detail='Image vide.')
    if len(raw) > VISION_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail='Image trop volumineuse (10 Mo max).')
    extension = next(
        (ext for magic, ext in _IMAGE_MAGIC if raw.startswith(magic)), None)
    if extension is None:
        raise HTTPException(status_code=422, detail='Format d’image non pris en charge.')
    descriptor, path = tempfile.mkstemp(prefix='ani-vision-', suffix=extension)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(raw)
    os.chmod(path, 0o600)
    return path, extension


class CancelRequest(BaseModel):
    turn_key: str = Field(min_length=16, max_length=160, pattern=r'^[A-Za-z0-9_-]+$')


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    emotion: str = Field(default='neutral', max_length=24)
    turn_key: str | None = Field(default=None, min_length=16, max_length=160, pattern=r'^[A-Za-z0-9_-]+$')
    chunk_seq: int = Field(default=0, ge=0, le=10000)
    instructions: str = Field(default='', max_length=1000)


class AudioTimingRequest(BaseModel):
    event: str = Field(min_length=1, max_length=64, pattern=r'^[a-z0-9_.-]+$')
    turn_key: str | None = Field(default=None, min_length=16, max_length=160, pattern=r'^[A-Za-z0-9_-]+$')
    chunk_seq: int = Field(default=0, ge=0, le=10000)
    elapsed_ms: float | None = Field(default=None, ge=0, le=86_400_000)
    duration_ms: float | None = Field(default=None, ge=0, le=86_400_000)
    text: str = Field(default='', max_length=5000)
    detail: str = Field(default='', max_length=500)


@app.middleware('http')
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Permissions-Policy'] = 'camera=(self), geolocation=(), microphone=(self)'
    return response


@app.get('/api/health')
def health():
    return {'status': 'ready', 'companion': 'Ani'}


OLLAMA_BASE_URL = os.getenv('ANI_OLLAMA_BASE_URL', 'http://127.0.0.1:11434')
MODELS_CACHE_TTL_SECONDS = max(1, int(os.getenv('ANI_MODELS_CACHE_TTL_SECONDS', '30')))
_models_cache: tuple[float, list[dict]] | None = None
MODELS_RE = re.compile(r'^[A-Za-z0-9._:/-]{1,160}$')


def fetch_local_models() -> list[dict]:
    global _models_cache
    now = time.monotonic()
    if _models_cache is not None and now - _models_cache[0] < MODELS_CACHE_TTL_SECONDS:
        return _models_cache[1]
    request = urllib.request.Request(f'{OLLAMA_BASE_URL}/api/tags')
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.load(response)
    except (OSError, ValueError):
        payload = {}
    models = [
        {
            'id': entry.get('name', ''),
            'vision': bool(entry.get('capabilities')) and 'vision' in entry.get('capabilities', []),
        }
        for entry in payload.get('models', [])
        if entry.get('name')
    ]
    if models:
        _models_cache = (now, models)
    return models


async def resolve_model_async(requested: str | None) -> str:
    if requested is None:
        return HERMES_MODEL
    candidate = requested.strip()
    if not candidate or not MODELS_RE.fullmatch(candidate):
        raise HTTPException(status_code=422, detail='Modèle inconnu.')
    catalog = await asyncio.to_thread(fetch_local_models)
    if candidate not in {model['id'] for model in catalog}:
        raise HTTPException(status_code=422, detail='Modèle inconnu.')
    return candidate


@app.get('/api/models')
def list_models():
    models = fetch_local_models()
    if not models:
        models = [{'id': HERMES_MODEL, 'vision': False}]
    return {'models': models}


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
        '--model',
        HERMES_MODEL,
        '--provider',
        HERMES_PROVIDER,
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


async def _cancel_registered_tts(turn_key: str) -> bool:
    audio_task = ACTIVE_TTS_TASKS.pop(turn_key, None)
    if audio_task and not audio_task.done():
        audio_task.cancel()
        await asyncio.gather(audio_task, return_exceptions=True)
    return audio_task is not None


@app.post('/api/cancel')
async def cancel(payload: CancelRequest):
    process = ACTIVE_CHAT_PROCESSES.pop(payload.turn_key, None)
    audio_cancelled = await _cancel_registered_tts(payload.turn_key)
    if process and process.returncode is None:
        await _stop_gateway_process(process, graceful=False)
    return {'cancelled': process is not None or audio_cancelled}


@app.post('/api/tts/cancel')
async def cancel_tts(payload: CancelRequest):
    return {'cancelled': await _cancel_registered_tts(payload.turn_key)}


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


async def _fetch_qwen_audio_async(
    text: str,
    instructions: str = '',
    *,
    trace: str = '-',
    chunk_seq: int = 0,
) -> bytes:
    request = build_qwen_tts_request(text, instructions)
    assert isinstance(request.data, bytes)
    content = request.data
    async with httpx.AsyncClient(timeout=180) as client:
        for attempt in range(1, 4):
            started = time.perf_counter()
            logger.info(
                '[ANI-TIMING] tts.attempt.start trace=%s chunk=%d attempt=%d chars=%d',
                trace, chunk_seq, attempt, len(text),
            )
            response = await client.post(QWEN_TTS_URL, content=content, headers={'Content-Type': 'application/json'})
            response.raise_for_status()
            metrics = _wav_metrics(response.content)
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.info(
                '[ANI-TIMING] tts.attempt.done trace=%s chunk=%d attempt=%d generation_ms=%.1f '
                'bytes=%d duration_ms=%.1f peak=%d rms=%.1f audible=%s '
                'leading_silence_ms=%.1f trailing_silence_ms=%.1f longest_silence_ms=%.1f',
                trace, chunk_seq, attempt, elapsed_ms, len(response.content),
                metrics['duration_ms'], metrics['peak'], metrics['rms'], metrics['audible'],
                metrics['leading_silence_ms'], metrics['trailing_silence_ms'], metrics['longest_silence_ms'],
            )
            if metrics['audible']:
                return response.content
            logger.warning(
                '[ANI-TIMING] tts.attempt.silent trace=%s chunk=%d attempt=%d raw_text=%r',
                trace, chunk_seq, attempt, text,
            )
    raise RuntimeError('Qwen TTS returned silent audio')


def _wav_metrics(audio: bytes) -> dict[str, float | int | bool]:
    empty = {
        'duration_ms': 0.0,
        'peak': 0,
        'rms': 0.0,
        'audible': False,
        'leading_silence_ms': 0.0,
        'trailing_silence_ms': 0.0,
        'longest_silence_ms': 0.0,
    }
    try:
        with wave.open(io.BytesIO(audio), 'rb') as wav:
            sample_width = wav.getsampwidth()
            frame_rate = wav.getframerate()
            frame_count = wav.getnframes()
            channels = wav.getnchannels()
            pcm = wav.readframes(frame_count)
    except (EOFError, wave.Error):
        return empty
    duration_ms = frame_count / frame_rate * 1000 if frame_rate else 0.0
    if sample_width != 2 or not frame_rate or not channels:
        return {**empty, 'duration_ms': duration_ms}
    samples = [sample for (sample,) in struct.iter_unpack('<h', pcm[:len(pcm) // 2 * 2])]
    if not samples:
        return {**empty, 'duration_ms': duration_ms}
    peak = max(abs(sample) for sample in samples)
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    block_samples = max(channels, round(frame_rate * channels * 0.02))
    audible_blocks = []
    for start in range(0, len(samples), block_samples):
        block = samples[start:start + block_samples]
        block_peak = max(abs(sample) for sample in block)
        block_rms = math.sqrt(sum(sample * sample for sample in block) / len(block))
        audible_blocks.append(block_peak >= 100 and block_rms >= 25)

    leading_blocks = next((index for index, audible in enumerate(audible_blocks) if audible), len(audible_blocks))
    trailing_blocks = next((index for index, audible in enumerate(reversed(audible_blocks)) if audible), len(audible_blocks))
    longest_blocks = current_blocks = 0
    for audible in audible_blocks:
        current_blocks = 0 if audible else current_blocks + 1
        longest_blocks = max(longest_blocks, current_blocks)
    block_ms = block_samples / (frame_rate * channels) * 1000
    return {
        'duration_ms': duration_ms,
        'peak': peak,
        'rms': rms,
        'audible': peak >= 100 and rms >= 25,
        'leading_silence_ms': min(duration_ms, leading_blocks * block_ms),
        'trailing_silence_ms': min(duration_ms, trailing_blocks * block_ms),
        'longest_silence_ms': min(duration_ms, longest_blocks * block_ms),
    }


def _wav_is_audible(audio: bytes) -> bool:
    return bool(_wav_metrics(audio)['audible'])


def prepare_spoken_text(text: str) -> str:
    spoken = re.sub(r'^\([^)]+\)\s*', '', text.strip())
    spoken = re.sub(r'\[[^\]]+\]', ' ', spoken)
    spoken = re.sub(r'\s*[—–―]\s*|\s+-\s+', '. ', spoken)
    spoken = re.sub(r'(?:\.(?:\s*\.)+|[…⋯]+)', ', ', spoken)
    spoken = re.sub(r'([.!?])\s*\1+', r'\1', spoken)
    spoken = ''.join(char for char in spoken if unicodedata.category(char) != 'So')
    spoken = re.sub(r'\s+([,.!?])', r'\1', spoken)
    return re.sub(r'\s+', ' ', spoken).strip()


ACTION_CUES = {
    'dance': ('danse', 'dance', 'dansant'),
    'spin': ('tourne', 'tourne sur elle-même', 'spin'),
    'jump': ('saute', 'jump'),
    'sway': ('se balance', 'balance', 'sway'),
    'tease': ('taquine', 'tease'),
}


def extract_reply_actions(text: str) -> list[dict[str, str]]:
    cues = [cue.strip().casefold() for cue in re.findall(r'\[([^\]]+)\]', text)]
    return [
        {'name': action}
        for action, aliases in ACTION_CUES.items()
        if any(cue in aliases for cue in cues)
    ]


def prepare_display_text(text: str) -> str:
    display = re.sub(r'^\([^)]+\)\s*', '', text.strip())
    display = re.sub(r'\[[^\]]+\]', ' ', display)
    display = re.sub(r'\s+([,.!?])', r'\1', display)
    return re.sub(r'\s+', ' ', display).strip()


def build_reply_presentation(text: str) -> dict:
    return {
        'reply': prepare_display_text(text),
        'speech': prepare_spoken_text(text),
        'emotion': classify_emotion(text),
        'actions': extract_reply_actions(text),
    }


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


class StreamingSpeechBuffer:
    def __init__(self):
        self.buffer = ''
        self.short_prefix = ''

    def _plan_segment(self, segment: str, final: bool = False) -> list[str]:
        spoken = prepare_spoken_text(segment)
        if not spoken:
            return []
        if self.short_prefix:
            prefix = re.sub(r'[.!?]+$', ',', self.short_prefix)
            spoken = f'{prefix} {spoken}'
            self.short_prefix = ''
        if len(spoken) < 24 and not final:
            self.short_prefix = spoken
            return []
        return split_spoken_chunks(spoken)

    def feed(self, delta: str) -> list[str]:
        self.buffer += delta
        chunks: list[str] = []
        while match := re.search(r'(?<!\.)[.!?](?!\.)(?=\s)', self.buffer):
            end = match.end()
            segment, self.buffer = self.buffer[:end], self.buffer[end:].lstrip()
            chunks.extend(self._plan_segment(segment))
        return chunks

    def finish(self) -> list[str]:
        chunks = self.feed('')
        tail = self.buffer
        self.buffer = ''
        if tail:
            chunks.extend(self._plan_segment(tail, final=True))
        elif self.short_prefix:
            chunks.extend(split_spoken_chunks(self.short_prefix))
            self.short_prefix = ''
        return chunks


def _stream_event(event_type: str, **payload) -> bytes:
    return (json.dumps({'type': event_type, **payload}, ensure_ascii=False) + '\n').encode('utf-8')


STREAMING_VOICE_INSTRUCTION = (
    "\n\nInstruction de forme pour la voix : commence par une première phrase à environ dix mots maximum, "
    "complète et naturelle. Écris sans points de suspension ; préfère une virgule ou un point. "
    "Réponds de façon concise : deux ou trois phrases courtes suffisent, sauf si on te demande un développement."
)


def build_streaming_prompt(message: str) -> str:
    return message.rstrip() + STREAMING_VOICE_INSTRUCTION


def raise_for_gateway_completion(payload: dict) -> None:
    status = str(payload.get('status') or '').casefold()
    if status not in {'error', 'failed', 'cancelled'}:
        return
    detail = payload.get('error') or payload.get('message') or payload.get('text') or 'Hermes turn failed'
    raise RuntimeError(str(detail))


def _remaining_gateway_time(deadline: float) -> float:
    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        raise asyncio.TimeoutError
    return remaining


@asynccontextmanager
async def _semaphore_before_deadline(semaphore: asyncio.Semaphore, deadline: float):
    await asyncio.wait_for(semaphore.acquire(), timeout=_remaining_gateway_time(deadline))
    try:
        yield
    finally:
        semaphore.release()


async def _read_gateway_message(
    process: asyncio.subprocess.Process,
    deadline: float,
) -> dict:
    if process.stdout is None:
        raise RuntimeError('Hermes streaming stdout is unavailable')
    while True:
        line = await asyncio.wait_for(
            process.stdout.readline(),
            timeout=_remaining_gateway_time(deadline),
        )
        if not line:
            raise RuntimeError('Hermes streaming gateway stopped unexpectedly')
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue


async def _gateway_rpc(
    process: asyncio.subprocess.Process,
    request_id: str,
    method: str,
    params: dict,
    notifications: deque[dict],
    deadline: float,
) -> dict:
    if process.stdin is None:
        raise RuntimeError('Hermes streaming stdin is unavailable')
    request = {'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}
    process.stdin.write((json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'))
    await process.stdin.drain()
    while True:
        message = await _read_gateway_message(process, deadline)
        if message.get('id') == request_id:
            if error := message.get('error'):
                raise RuntimeError(str(error.get('message') or error))
            return message.get('result') or {}
        params_data = message.get('params') or {}
        if params_data.get('type') == 'error':
            payload = params_data.get('payload') or {}
            raise RuntimeError(str(payload.get('message') or 'Hermes streaming error'))
        notifications.append(message)


async def _drain_gateway_stderr(
    stream: asyncio.StreamReader,
    *,
    max_bytes: int = 16 * 1024,
) -> bytes:
    tail = bytearray()
    while chunk := await stream.read(4096):
        tail.extend(chunk)
        if len(tail) > max_bytes:
            del tail[:-max_bytes]
    return bytes(tail)


def _signal_gateway_process(process: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    pid = getattr(process, 'pid', None)
    if isinstance(pid, int) and pid > 0:
        try:
            os.killpg(pid, sig)
            return
        except ProcessLookupError:
            return
    if sig == signal.SIGKILL:
        process.kill()
    else:
        process.terminate()


async def _stop_gateway_process(
    process: asyncio.subprocess.Process,
    *,
    graceful: bool = True,
) -> None:
    if process.returncode is not None:
        return
    if process.stdin is not None:
        process.stdin.close()
    if graceful:
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
            return
        except asyncio.TimeoutError:
            pass
    _signal_gateway_process(process, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        _signal_gateway_process(process, signal.SIGKILL)
        await process.wait()


def _clear_stale_turn_lease(session_id: str) -> None:
    """Remove leftover session-turn leases whose holder process is dead. /api/cancel SIGKILLs the
    gateway process mid-turn, which orphans its DB lease for up to LEASE_TTL (5 min); the next
    turn then blocks on the lease and fails with 'another Hermes process'."""
    if not session_id or not SESSION_RE.fullmatch(session_id):
        return
    db_path = Path(HERMES_HOME) / 'state.db'
    if not db_path.is_file():
        return
    try:
        import sqlite3

        connection = sqlite3.connect(db_path, timeout=2)
        try:
            rows = connection.execute(
                'SELECT holder FROM session_turn_leases WHERE conversation_id = ?',
                (session_id,),
            ).fetchall()
            stale = []
            for (holder,) in rows:
                match = re.match(r'pid=(\d+)', str(holder))
                if not match:
                    continue
                pid = int(match.group(1))
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    stale.append((session_id, holder))
                except PermissionError:
                    continue  # holder alive, not ours
            for args in stale:
                connection.execute(
                    'DELETE FROM session_turn_leases WHERE conversation_id = ? AND holder = ?',
                    args,
                )
            if stale:
                connection.commit()
                logger.info('Cleared %d stale session turn lease(s) for %s', len(stale), session_id)
        finally:
            connection.close()
    except Exception:
        logger.debug('Stale lease cleanup skipped', exc_info=True)


async def stream_chat_events(payload: ChatRequest, turn_key: str):
    process = None
    stderr_task = None
    image_path = None
    planner = StreamingSpeechBuffer()
    reply_parts: list[str] = []
    stored_session_id = payload.session_id
    notifications: deque[dict] = deque()
    compression_active = False
    deadline = asyncio.get_running_loop().time() + CHAT_TIMEOUT_SECONDS
    profile_home = HERMES_PROFILES.get(payload.profile, HERMES_PROFILES[DEFAULT_PROFILE])
    selected_model = await resolve_model_async(payload.model)
    await asyncio.to_thread(_clear_stale_turn_lease, payload.session_id or '')
    try:
        async with _semaphore_before_deadline(RUN_SEMAPHORE, deadline):
            process = await asyncio.wait_for(
                asyncio.create_subprocess_exec(
                    HERMES_PYTHON,
                    '-u',
                    '-m',
                    'tui_gateway.entry',
                    cwd=profile_home,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                    env={
                        **os.environ,
                        'HERMES_HOME': profile_home,
                        'HERMES_MODEL': selected_model,
                        'HERMES_INFERENCE_PROVIDER': HERMES_PROVIDER,
                        'HERMES_TUI_TOOLSETS': HERMES_TUI_TOOLSETS,
                        'PYTHONPATH': os.pathsep.join(
                            part for part in (HERMES_AGENT_ROOT, os.environ.get('PYTHONPATH')) if part
                        ),
                        'PYTHONUNBUFFERED': '1',
                    },
                ),
                timeout=_remaining_gateway_time(deadline),
            )
            ACTIVE_CHAT_PROCESSES[turn_key] = process
            if process.stderr is not None:
                stderr_task = asyncio.create_task(_drain_gateway_stderr(process.stderr))

            while True:
                message = await _read_gateway_message(process, deadline)
                params_data = message.get('params') or {}
                if params_data.get('type') == 'gateway.ready':
                    break
                notifications.append(message)

            if payload.session_id:
                session = await _gateway_rpc(
                    process,
                    '1',
                    'session.resume',
                    {'session_id': payload.session_id, 'omit_messages': True, 'eager_build': True},
                    notifications,
                    deadline,
                )
            else:
                session = await _gateway_rpc(
                    process,
                    '1',
                    'session.create',
                    {'cols': 80, 'model': selected_model, 'provider': HERMES_PROVIDER},
                    notifications,
                    deadline,
                )
            runtime_session_id = session.get('session_id')
            stored_session_id = session.get('stored_session_id') or stored_session_id
            if not runtime_session_id or not stored_session_id:
                raise RuntimeError('Hermes did not create a resumable session')
            yield _stream_event('start', session_id=stored_session_id, turn_key=turn_key)

            await _gateway_rpc(
                process,
                '2',
                'config.set',
                {
                    'session_id': runtime_session_id,
                    'key': 'model',
                    'value': f'{selected_model} --provider {HERMES_PROVIDER} --session',
                    'confirm_expensive_model': True,
                },
                notifications,
                deadline,
            )
            if payload.image:
                image_path, _extension = await asyncio.to_thread(
                    decode_image_data_url, payload.image)
                attached = await _gateway_rpc(
                    process,
                    '2b',
                    'image.attach',
                    {'session_id': runtime_session_id, 'path': image_path},
                    notifications,
                    deadline,
                )
                if not attached.get('attached'):
                    logger.warning('Image attach failed: %r', attached)
            submitted = await _gateway_rpc(
                process,
                '3',
                'prompt.submit',
                {'session_id': runtime_session_id, 'text': build_streaming_prompt(payload.message)},
                notifications,
                deadline,
            )
            if submitted.get('status') != 'streaming':
                logger.warning(
                    'Submit did not stream: status=%r result_keys=%s',
                    submitted.get('status'),
                    sorted(submitted.keys()),
                )
                raise RuntimeError('Hermes did not start streaming')

            while True:
                message = (
                    notifications.popleft()
                    if notifications
                    else await _read_gateway_message(process, deadline)
                )
                params_data = message.get('params') or {}
                event_type = params_data.get('type')
                event_payload = params_data.get('payload') or {}
                if event_type == 'session.info':
                    stored_session_id = event_payload.get('stored_session_id') or stored_session_id
                    continue
                if event_type == 'status.update':
                    status_kind = event_payload.get('kind')
                    if status_kind == 'compacting':
                        if not compression_active:
                            compression_active = True
                            yield _stream_event('phase', phase='compression')
                        continue
                    if status_kind == 'compacted' and compression_active:
                        compression_active = False
                        yield _stream_event('phase', phase='llm')
                        continue
                if event_type == 'message.delta':
                    delta = str(event_payload.get('text') or '')
                    if not delta:
                        continue
                    reply_parts.append(delta)
                    yield _stream_event('delta', text=delta)
                    for chunk in planner.feed(delta):
                        yield _stream_event(
                            'speech',
                            text=chunk,
                            emotion=classify_emotion(''.join(reply_parts)),
                        )
                    continue
                if event_type == 'error':
                    raise RuntimeError(str(event_payload.get('message') or 'Hermes streaming error'))
                if event_type != 'message.complete':
                    continue

                raise_for_gateway_completion(event_payload)
                streamed_reply = ''.join(reply_parts)
                final_reply = str(event_payload.get('text') or streamed_reply)
                missing_suffix = (
                    final_reply[len(streamed_reply):]
                    if streamed_reply and final_reply.startswith(streamed_reply)
                    else ''
                )
                if not streamed_reply and final_reply:
                    reply_parts.append(final_reply)
                    yield _stream_event('delta', text=final_reply)
                    for chunk in planner.feed(final_reply):
                        yield _stream_event('speech', text=chunk, emotion=classify_emotion(final_reply))
                elif missing_suffix:
                    reply_parts.append(missing_suffix)
                    yield _stream_event('delta', text=missing_suffix)
                    for chunk in planner.feed(missing_suffix):
                        yield _stream_event('speech', text=chunk, emotion=classify_emotion(final_reply))
                for chunk in planner.finish():
                    yield _stream_event('speech', text=chunk, emotion=classify_emotion(final_reply))
                if not final_reply.strip():
                    raise RuntimeError("Ani n'a produit aucune réponse.")
                presentation = build_reply_presentation(final_reply)
                yield _stream_event(
                    'complete',
                    **presentation,
                    session_id=stored_session_id,
                )
                break
    except asyncio.TimeoutError:
        yield _stream_event('error', message="Le délai de réponse d'Ani est dépassé.")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception('Hermes streaming failed')
        yield _stream_event('error', message='La réponse locale d’Ani a échoué.')
    finally:
        if image_path:
            _delete_file(image_path)
        if process is not None:
            if ACTIVE_CHAT_PROCESSES.get(turn_key) is process:
                ACTIVE_CHAT_PROCESSES.pop(turn_key, None)
            await _stop_gateway_process(process)
        if stderr_task is not None:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)


@app.post('/api/chat/stream')
async def chat_stream(payload: ChatRequest):
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail='Le message est vide.')
    if payload.session_id and not SESSION_RE.fullmatch(payload.session_id):
        raise HTTPException(status_code=422, detail='Invalid session id')
    if payload.profile not in HERMES_PROFILES:
        raise HTTPException(status_code=422, detail='Profil inconnu.')
    await resolve_model_async(payload.model)
    payload.message = message
    turn_key = secrets.token_urlsafe(24)
    return StreamingResponse(
        stream_chat_events(payload, turn_key),
        media_type='application/x-ndjson',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


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
        'instructions': payload.instructions,
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


@app.post('/api/audio/timing')
async def audio_timing(payload: AudioTimingRequest):
    trace = payload.turn_key[:10] if payload.turn_key else '-'
    elapsed = f'{payload.elapsed_ms:.1f}' if payload.elapsed_ms is not None else '-'
    duration = f'{payload.duration_ms:.1f}' if payload.duration_ms is not None else '-'
    logger.info(
        '[ANI-TIMING] client.%s trace=%s chunk=%d elapsed_ms=%s duration_ms=%s text=%r detail=%r',
        payload.event, trace, payload.chunk_seq, elapsed, duration, payload.text, payload.detail,
    )
    return {'logged': True}


@app.post('/api/tts')
async def tts(payload: TTSRequest, background_tasks: BackgroundTasks):
    request_started = time.perf_counter()
    trace = payload.turn_key[:10] if payload.turn_key else secrets.token_hex(5)
    spoken = prepare_spoken_text(payload.text)
    instructions = payload.instructions
    logger.info(
        '[ANI-TIMING] tts.request trace=%s chunk=%d chars=%d ellipsis=%d raw_text=%r spoken_text=%r',
        trace, payload.chunk_seq, len(spoken),
        len(re.findall(r'(?:\.{2,}|[…⋯]+)', payload.text)), payload.text, spoken,
    )
    if not spoken:
        raise HTTPException(status_code=422, detail='Aucun texte à prononcer.')
    fd, path = tempfile.mkstemp(prefix='ani-', suffix='.wav')
    os.close(fd)
    audio_task = asyncio.create_task(_fetch_qwen_audio_async(
        spoken,
        instructions,
        trace=trace,
        chunk_seq=payload.chunk_seq,
    ))
    if payload.turn_key:
        ACTIVE_TTS_TASKS[payload.turn_key] = audio_task
    try:
        audio = await audio_task
        Path(path).write_bytes(audio)
        metrics = _wav_metrics(audio)
        logger.info(
            '[ANI-TIMING] tts.ready trace=%s chunk=%d total_ms=%.1f bytes=%d duration_ms=%.1f '
            'peak=%d rms=%.1f leading_silence_ms=%.1f trailing_silence_ms=%.1f '
            'longest_silence_ms=%.1f spoken_text=%r',
            trace, payload.chunk_seq, (time.perf_counter() - request_started) * 1000,
            len(audio), metrics['duration_ms'], metrics['peak'], metrics['rms'],
            metrics['leading_silence_ms'], metrics['trailing_silence_ms'], metrics['longest_silence_ms'], spoken,
        )
    except asyncio.CancelledError:
        logger.info(
            '[ANI-TIMING] tts.cancelled trace=%s chunk=%d total_ms=%.1f spoken_text=%r',
            trace, payload.chunk_seq, (time.perf_counter() - request_started) * 1000, spoken,
        )
        _delete_file(path)
        raise
    except Exception as exc:
        logger.exception(
            '[ANI-TIMING] tts.failed trace=%s chunk=%d total_ms=%.1f spoken_text=%r',
            trace, payload.chunk_seq, (time.perf_counter() - request_started) * 1000, spoken,
        )
        _delete_file(path)
        raise HTTPException(status_code=502, detail='La voix est momentanément indisponible.') from exc
    finally:
        if payload.turn_key and ACTIVE_TTS_TASKS.get(payload.turn_key) is audio_task:
            ACTIVE_TTS_TASKS.pop(payload.turn_key, None)
    background_tasks.add_task(_delete_file, path)
    return FileResponse(path, media_type='audio/wav', filename='ani.wav')


app.mount('/', StaticFiles(directory=STATIC, html=True), name='static')
