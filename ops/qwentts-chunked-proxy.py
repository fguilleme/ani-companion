#!/usr/bin/env python3
"""Small OpenAI-compatible chunking proxy for qwentts.cpp.

Why: qwentts.cpp produces good short French speech, but long monolithic requests
can degrade into unintelligible audio. This proxy keeps each backend request
bounded, then concatenates the returned PCM WAV files.
"""

from __future__ import annotations

import audioop
import io
import json
import logging
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BACKEND = "http://127.0.0.1:15003"
CLONE_BACKEND = "http://127.0.0.1:15006"
HOST = "0.0.0.0"
PORT = 15004
MAX_CHARS_PER_CHUNK = 900
MAX_BACKEND_TOKENS_PER_CHUNK = 1600
# qwentts preset voices are stable in short requests but can drift into
# silence/noise when asked for long monolithic generations. Keep short narration
# direct for smoothness; split longer preset narration into tight chunks.
QWEN_DIRECT_MAX_CHARS = 250
QWEN_PRESET_CHARS_PER_CHUNK = 220
QWEN_PRESET_MAX_FRAMES_PER_CHUNK = 380
REQUEST_TIMEOUT = 240
RAW_PCM_RATE = 24000
RAW_PCM_CHANNELS = 1
RAW_PCM_SAMPWIDTH = 2
# Fish voice cloning can take several minutes per cloned segment on ROCm.
# Keep the normal Qwen preset timeout short, but allow cloned-speaker chunks to
# finish instead of making n8n see ECONNRESET/socket hang up while Fish is still
# generating successfully in the background.
# Fish Speech clone chunks are extremely slow on ROCm/iGPU. A single 850-char
# cloned top-level chunk can take ~1050s; timing out at 900s leaves Fish running
# after the UI/job has already failed, increasing OOM risk. Keep this high and
# let the async Revoice worker own the long wall clock.
CLONE_REQUEST_TIMEOUT = int(os.environ.get("CLONE_REQUEST_TIMEOUT", "2400"))
CHUNK_DUMP_DIR = Path("/tmp/qwentts-chunks")
CHUNK_DUMP_RETENTION_SECONDS = 24 * 60 * 60

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)


def post_json(url: str, payload: dict[str, Any], timeout: int = REQUEST_TIMEOUT) -> tuple[int, dict[str, str], bytes]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except Exception as e:
        logging.warning("backend request failed url=%s timeout=%ss error=%r", url, timeout, e)
        body = json.dumps({"error": "backend request failed", "detail": str(e)}, ensure_ascii=False).encode("utf-8")
        return 599, {"content-type": "application/json"}, body


def get_url(url: str, timeout: int = 15) -> tuple[int, dict[str, str], bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def cleanup_old_chunk_dumps(now: float | None = None) -> None:
    now = time.time() if now is None else now
    try:
        CHUNK_DUMP_DIR.mkdir(parents=True, exist_ok=True)
        for path in CHUNK_DUMP_DIR.iterdir():
            try:
                if now - path.stat().st_mtime > CHUNK_DUMP_RETENTION_SECONDS:
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                    logging.info("deleted old chunk dump %s", path)
            except FileNotFoundError:
                pass
            except Exception:
                logging.exception("failed to delete old chunk dump %s", path)
    except Exception:
        logging.exception("chunk dump cleanup failed")


def safe_name(value: str, fallback: str = "x") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(value or "").strip())
    cleaned = cleaned.strip("._-")
    return cleaned[:80] or fallback


def new_chunk_dump_dir() -> Path:
    cleanup_old_chunk_dumps()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = CHUNK_DUMP_DIR / f"{stamp}-{int(time.time() * 1000) % 100000:05d}"
    path = base
    suffix = 1
    while path.exists():
        suffix += 1
        path = CHUNK_DUMP_DIR / f"{base.name}-{suffix}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def dump_chunk_audio(dump_dir: Path | None, *, index: int, total: int, speaker: str, voice: str, chunk: str, blob: bytes, stage: str = "final") -> None:
    if dump_dir is None:
        return
    try:
        name = f"chunk-{index:03d}-of-{total:03d}-{safe_name(speaker, 'speaker')}-{safe_name(voice, 'voice')}-{safe_name(stage, 'final')}.wav"
        wav_path = dump_dir / name
        wav_path.write_bytes(blob)
        meta_path = dump_dir / f"chunk-{index:03d}-of-{total:03d}-{safe_name(stage, 'final')}.json"
        meta_path.write_text(json.dumps({
            "index": index,
            "total": total,
            "speaker": speaker,
            "voice": voice,
            "stage": stage,
            "chars": len(chunk),
            "text": chunk,
            "wav": str(wav_path),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "delete_after_seconds": CHUNK_DUMP_RETENTION_SECONDS,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        logging.info("saved chunk audio %s", wav_path)
    except Exception:
        logging.exception("failed to save chunk audio dump")


def split_text(
    text: str,
    max_chars: int = MAX_CHARS_PER_CHUNK,
    one_sentence_per_chunk: bool = False,
) -> list[str]:
    text = str(text or "")
    # --- Strip LLM thinking/reasoning before TTS ---
    # 1. Explicit tags (common with qwen/deepseek/Gemini thinking mode)
    text = re.sub(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"</think(?:ing)?>", "", text, flags=re.IGNORECASE)
    # 2. Meta-commentary sentences (LLM "thinking aloud" without tags)
    #    e.g. "pense à l'intérieur du modèle pour générer le résultat final"
    text = re.sub(
        r"(?:^|(?<=[.!?]\s))"  # start of sentence
        r"\s*"
        r"(?:"
        r"pense[zs]?\s+(?:à\s+)?l['\u2019]intérieur(?:\s+du\s+modèle)?"
        r"|réfléchis?[sz]?\s+(?:à\s+)?(?:la\s+)?(?:question|réponse|suite)"
        r"|d['\u2019]abord(?:,?\s+)?je\s+(?:vais\s+)?(?:réfléchir|analyser|penser)"
        r"|pour\s+(?:générer|produire|créer)\s+(?:le\s+)?(?:résultat|texte|script|contenu)"
        r"|(?:je|nous)\s+(?:vais|allons|devons)\s+(?:d'abord\s+)?(?:réfléchir|penser|analyser)"
        r"|analyse[rt]?\s+(?:la\s+)?(?:question|situation|problème)"
        r"|(?:je\s+)?vais\s+(?:d'abord\s+)?(?:réfléchir|analyser|penser)"
        r"|voici\s+(?:ma\s+)?(?:réflexion|analyse|pensée)"
        r"|(?:tout\s+)?d'abord[,.\s]+(?:laisse[- ]moi\s+)?(?:réfléchir|analyser|penser)"
        r"|let\s+me\s+think"
        r"|thinking\s+(?:about|through|carefully)"
        r"|I\s+need\s+to\s+(?:think|consider|analyze)"
        r"|(?:to\s+)?(?:generate|produce|create)\s+(?:the\s+)?(?:result|text|script)"
        r")"
        r"(?:\s+final(?:ement)?)?"
        r"[.!?]?"
        r"\s*",
        " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    # Prefer sentence boundaries. Keep punctuation with the sentence.
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    if one_sentence_per_chunk:
        # Keep semantic sentence boundaries for conversational TTS. Very short
        # interjections such as "Oh." are attached to the following sentence so
        # qwentts does not receive an unstable one-word request.
        merged_sentences: list[str] = []
        prefix = ""
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            if len(sentence) < 24:
                prefix = f"{prefix} {sentence}".strip()
                continue
            if prefix:
                sentence = f"{prefix} {sentence}"
                prefix = ""
            merged_sentences.append(sentence)
        if prefix:
            if merged_sentences and len(merged_sentences[-1]) + len(prefix) + 1 <= max_chars:
                merged_sentences[-1] = f"{merged_sentences[-1]} {prefix}"
            else:
                merged_sentences.append(prefix)
        sentences = merged_sentences
    chunks: list[str] = []
    cur = ""
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        if one_sentence_per_chunk and len(sent) <= max_chars:
            if cur:
                chunks.append(cur.strip())
                cur = ""
            chunks.append(sent)
            continue
        if len(sent) > max_chars:
            # Fall back to comma/semicolon-ish chunks, then hard-wrap if needed.
            parts = re.split(r"(?<=[,;:])\s+", sent)
        else:
            parts = [sent]
        for part in parts:
            part = part.strip()
            while len(part) > max_chars:
                cut = part.rfind(" ", 0, max_chars)
                if cut < max_chars // 2:
                    cut = max_chars
                piece, part = part[:cut].strip(), part[cut:].strip()
                if cur:
                    chunks.append(cur.strip())
                    cur = ""
                if piece:
                    chunks.append(piece)
            if not part:
                continue
            if cur and len(cur) + 1 + len(part) > max_chars:
                chunks.append(cur.strip())
                cur = part
            else:
                cur = f"{cur} {part}".strip() if cur else part
        if one_sentence_per_chunk and cur:
            chunks.append(cur.strip())
            cur = ""
    if cur:
        chunks.append(cur.strip())
    return chunks



def normalize_speaker_label(value: Any) -> str:
    label = str(value or "").strip().lower()
    label = label.rstrip(":：-").strip()
    label = label.replace("é", "e").replace("è", "e").replace("ê", "e").replace("à", "a")
    return re.sub(r"\s+", " ", label)


def is_clone_voice(voice: Any) -> bool:
    return str(voice or "").strip().lower().startswith("clone:")


def is_valid_voice(voice: Any) -> bool:
    allowed = {"serena", "vivian", "uncle_fu", "ryan", "aiden", "ono_anna", "sohee", "eric", "dylan"}
    v = str(voice or "").strip().lower()
    return v in allowed or v.startswith("clone:") or v == "voice-clone"


def speaker_voice_map(payload: dict[str, Any]) -> dict[str, str]:
    allowed = {"serena", "vivian", "uncle_fu", "ryan", "aiden", "ono_anna", "sohee", "eric", "dylan"}
    default_voice = str(payload.get("voice") or "vivian").strip().lower()
    if not is_valid_voice(default_voice):
        default_voice = "vivian"

    mapping: dict[str, str] = {
        "narrateur": default_voice,
        "locuteur 1": str(payload.get("speaker_1_voice") or default_voice).strip().lower(),
        "speaker 1": str(payload.get("speaker_1_voice") or default_voice).strip().lower(),
        "locuteur 2": str(payload.get("speaker_2_voice") or default_voice).strip().lower(),
        "speaker 2": str(payload.get("speaker_2_voice") or default_voice).strip().lower(),
    }

    configs = payload.get("speakerVoiceConfigs") or payload.get("speaker_voice_configs") or []
    if isinstance(configs, list):
        for cfg in configs:
            if not isinstance(cfg, dict):
                continue
            speaker = normalize_speaker_label(cfg.get("speaker") or cfg.get("label") or cfg.get("name"))
            voice = str(cfg.get("voice") or "").strip().lower()
            if speaker and is_valid_voice(voice):
                mapping[speaker] = voice

    # Common aliases from prompt/UI labels.
    if is_valid_voice(mapping.get("locuteur 1")):
        mapping.setdefault("ryan", mapping["locuteur 1"])
    if is_valid_voice(mapping.get("locuteur 2")):
        mapping.setdefault("serena", mapping["locuteur 2"])

    return {k: (v if is_valid_voice(v) else default_voice) for k, v in mapping.items()}


def clone_reference_for_voice(payload: dict[str, Any], speaker: str, voice: str) -> str:
    """Return the reference audio path for a cloned speaker.

    Current UI stores one clone profile at a time, so the top-level
    voice_clone_sample_path is normally enough. Support per-speaker config too
    so the pipeline is ready for multiple clones later.
    """
    configs = payload.get("speakerVoiceConfigs") or payload.get("speaker_voice_configs") or []
    speaker_key = normalize_speaker_label(speaker)
    if isinstance(configs, list):
        for cfg in configs:
            if not isinstance(cfg, dict):
                continue
            cfg_speaker = normalize_speaker_label(cfg.get("speaker") or cfg.get("label") or cfg.get("name"))
            cfg_voice = str(cfg.get("voice") or "").strip().lower()
            if cfg_speaker == speaker_key and cfg_voice == voice:
                ref = cfg.get("reference_audio_path") or cfg.get("voice_clone_sample_path") or cfg.get("speaker_wav")
                if ref:
                    return str(ref)
    return str(payload.get("voice_clone_sample_path") or payload.get("reference_audio_path") or payload.get("speaker_wav") or "")


def clone_fallback_voice(payload: dict[str, Any], speaker: str) -> str:
    """Audible preset fallback when Qwen clone returns invalid audio.

    Better a clearly non-cloned Qwen voice than concatenating silence/noise into
    the final podcast. Keep the fallback deterministic and distinct by speaker.
    """
    requested = str(payload.get("clone_fallback_voice") or "").strip().lower()
    if requested in {"serena", "vivian", "aiden", "ono_anna", "dylan"}:
        return requested
    key = normalize_speaker_label(speaker)
    return "vivian" if key.endswith("1") else "aiden"


def preset_fallback_voice(voice: str, speaker: str = "") -> str:
    v = str(voice or "").strip().lower()
    if v == "aiden":
        return "vivian"
    if v == "vivian":
        return "aiden"
    # Ryan stretches syllables; Eric/Uncle Fu can be silent. Do not use them as
    # emergency substitutes for failed chunks.
    return "aiden"


def preset_narration_cap(voice: str, text: str) -> int:
    """Frame cap for sentence-bounded qwentts preset narration chunks.

    Narration chunks are longer than dialogue turns. The previous `chars*0.82`
    cap cut final words (e.g. "chaotique" -> "chao") because qwentts often
    reaches the cap before EOS. Keep chunks shorter and give enough end margin;
    if qwentts emits EOS it will stop before the cap.
    """
    n = len(str(text or "").strip())
    v = str(voice or "").strip().lower()
    if v == "ryan":
        return max(80, min(180, int(n * 0.95)))
    if v in {"uncle_fu", "eric"}:
        return max(120, min(QWEN_PRESET_MAX_FRAMES_PER_CHUNK, int(n * 1.15)))
    return max(130, min(QWEN_PRESET_MAX_FRAMES_PER_CHUNK, int(n * 1.18)))


def preset_dialogue_cap(voice: str, text: str) -> int:
    """Frame cap for short qwentts preset dialogue turns.

    qwentts frames are ~80ms. A generic 70-frame minimum makes Ryan stretch
    syllables across seconds and makes fragile voices drift. Use voice-specific
    caps measured on short French dialogue turns.
    """
    n = len(str(text or "").strip())
    v = str(voice or "").strip().lower()
    if v == "ryan":
        # Ryan stretches if given huge caps, but the previous 30-50 frame range
        # cut some dialogue turns before the last syllables. Keep it tighter than
        # other voices, with enough tail margin to finish a phrase.
        return max(50, min(95, int(n * 0.85)))
    if v == "serena":
        # Serena often speaks slowly and was being cut at the end around 1.0x.
        return max(75, min(175, int(n * 1.28)))
    if v in {"eric", "uncle_fu"}:
        return max(70, min(175, int(n * 1.05)))
    # Generic preset voices need margin; qwentts does not always emit EOS before
    # a too-tight cap, causing audible chopped endings.
    return max(70, min(175, int(n * 1.10)))


def unique_ints(values: list[Any]) -> list[int]:
    out: list[int] = []
    for value in values:
        try:
            ivalue = int(value)
        except Exception:
            continue
        if ivalue not in out:
            out.append(ivalue)
    return out


def preset_voice_seed_candidates(voice: str, current_seed: Any = None) -> list[int]:
    """Seeds to try before giving up on a qwentts preset chunk.

    Qwen3-TTS customvoice can return silence for specific voice/text/seed
    combinations. Do not treat this as a dead voice immediately: retry known-good
    seeds first so Eric/Uncle Fu/Ryan keep their requested identity when possible.
    """
    v = str(voice or "").strip().lower()
    preferred = {
        "eric": [43, 123, 1, 2, 42],
        "sohee": [123, 42, 43, 1, 2],
        "uncle_fu": [43, 123, 1, 2, 42],
        "ryan": [42, 123, 43, 1, 2],
        "serena": [42, 123, 43, 1, 2],
    }.get(v, [42, 123, 43, 1, 2])
    # Prefer per-voice known-good seeds over a caller's generic seed=42. If the
    # caller supplied a non-default seed, still include it early as a candidate.
    current = [] if current_seed in (None, "", 42, "42") else [current_seed]
    return unique_ints(current + preferred)


def split_dialogue_segments(text: str, payload: dict[str, Any]) -> list[dict[str, str]]:
    """Return ordered {speaker,text,voice} segments.

    If text contains labels like "Locuteur 1:" / "Locuteur 2:", each labelled
    block gets its mapped voice. Unlabelled text falls back to payload.voice.
    """
    text = str(text or "").strip()
    voices = speaker_voice_map(payload)
    default_voice = voices.get("narrateur") or str(payload.get("voice") or "vivian")
    label_rx = re.compile(
        r"^\s*(Locuteur\s*[12]|Speaker\s*[12]|Narrateur|Ryan|Serena)\s*[:：-]\s*(.*)$",
        re.IGNORECASE,
    )
    segments: list[dict[str, str]] = []
    cur_speaker = "narrateur"
    cur_lines: list[str] = []

    def flush() -> None:
        nonlocal cur_lines, cur_speaker
        body = " ".join(line.strip() for line in cur_lines if line.strip()).strip()
        # Strip any remaining speaker labels in the body text
        body = re.sub(r"\bLocuteur\s*[12]\b", "", body, flags=re.IGNORECASE)
        body = re.sub(r"\bSpeaker\s*[12]\b", "", body, flags=re.IGNORECASE)
        body = re.sub(r"\bNarrateur\b", "", body, flags=re.IGNORECASE)
        body = re.sub(r"\s{2,}", " ", body).strip()
        if body:
            speaker_key = normalize_speaker_label(cur_speaker)
            segments.append({
                "speaker": cur_speaker,
                "text": body,
                "voice": voices.get(speaker_key, default_voice),
            })
        cur_lines = []

    for raw_line in re.split(r"\n+", text):
        line = raw_line.strip()
        if not line:
            continue
        m = label_rx.match(line)
        if m:
            flush()
            cur_speaker = re.sub(r"\s+", " ", m.group(1).strip())
            rest = m.group(2).strip()
            if rest:
                cur_lines.append(rest)
        else:
            cur_lines.append(line)
    flush()

    if not segments:
        segments = [{"speaker": "Narrateur", "text": text, "voice": default_voice}]
    return segments


def wav_from_pcm(pcm: bytes, *, rate: int = RAW_PCM_RATE, channels: int = RAW_PCM_CHANNELS, sampwidth: int = RAW_PCM_SAMPWIDTH) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def read_wav_pcm(blob: bytes, chunk_index: int | None = None) -> tuple[tuple[int, int, int], bytes]:
    if blob[:4] != b"RIFF":
        if len(blob) >= RAW_PCM_SAMPWIDTH and len(blob) % RAW_PCM_SAMPWIDTH == 0:
            logging.warning(
                "chunk %s is raw PCM without WAV header; wrapping as %dHz s%d mono len=%d",
                chunk_index,
                RAW_PCM_RATE,
                RAW_PCM_SAMPWIDTH * 8,
                len(blob),
            )
            return (RAW_PCM_CHANNELS, RAW_PCM_SAMPWIDTH, RAW_PCM_RATE), blob
    try:
        with wave.open(io.BytesIO(blob), "rb") as w:
            params = (w.getnchannels(), w.getsampwidth(), w.getframerate())
            pcm = w.readframes(w.getnframes())
        return params, pcm
    except Exception as e:
        prefix = blob[:200]
        raise ValueError(f"invalid wav at chunk {chunk_index}: {e}; first bytes={prefix!r}") from e


FRAGILE_PRESET_VOICES = {"uncle_fu", "eric"}


def trim_pcm_silence(params: tuple[int, int, int], pcm: bytes, *, threshold: int = 25, keep_ms: int = 450, min_keep_ratio: float = 0.80) -> bytes:
    """Trim low-energy leading silence only.

    Do not trim the tail: qwentts dialogue endings can be low-energy, and tail
    trimming was cutting final syllables/words. The only safe cleanup here is
    removing an obvious leading blank before the first active window.
    """
    channels, sampwidth, rate = params
    frame_size = channels * sampwidth
    if not pcm or frame_size <= 0:
        return pcm
    win_frames = max(1, rate // 20)  # 50 ms windows
    win_bytes = win_frames * frame_size
    n = len(pcm) // win_bytes
    if n <= 1:
        return pcm
    rms = [audioop.rms(pcm[i * win_bytes:(i + 1) * win_bytes], sampwidth) for i in range(n)]
    active = [i for i, v in enumerate(rms) if v >= threshold]
    if not active:
        return pcm
    keep_windows = max(1, int((keep_ms / 1000) * rate / win_frames))
    start_win = max(0, active[0] - keep_windows)
    start = start_win * win_bytes
    if start <= 0:
        return pcm
    trimmed = pcm[start:]
    if len(trimmed) < int(len(pcm) * min_keep_ratio):
        logging.warning(
            "skip aggressive leading trim %.2fs -> %.2fs threshold=%s",
            len(pcm) / frame_size / rate,
            len(trimmed) / frame_size / rate,
            threshold,
        )
        return pcm
    logging.info("leading-trim wav chunk %.2fs -> %.2fs threshold=%s", len(pcm) / frame_size / rate, len(trimmed) / frame_size / rate, threshold)
    return trimmed


def pcm_metrics(params: tuple[int, int, int], pcm: bytes, *, threshold: int = 60) -> dict[str, float]:
    channels, sampwidth, rate = params
    frame_size = channels * sampwidth
    if not pcm or frame_size <= 0:
        return {"duration": 0.0, "rms": 0.0, "max": 0.0, "active": 0.0, "first_active": 999.0}
    duration = len(pcm) / frame_size / rate
    win_frames = max(1, rate // 20)  # 50 ms
    win_bytes = win_frames * frame_size
    n = max(1, len(pcm) // win_bytes)
    rms_values = [audioop.rms(pcm[i * win_bytes:(i + 1) * win_bytes], sampwidth) for i in range(n)]
    active = [i for i, v in enumerate(rms_values) if v >= threshold]
    return {
        "duration": duration,
        "rms": float(audioop.rms(pcm, sampwidth)),
        "max": float(audioop.max(pcm, sampwidth)),
        "active": len(active) * win_frames / rate,
        "first_active": (active[0] * win_frames / rate) if active else 999.0,
    }


def wav_quality(blob: bytes, chunk_index: int | None = None) -> tuple[tuple[int, int, int], bytes, dict[str, float], bool]:
    params, pcm = read_wav_pcm(blob, chunk_index)
    metrics = pcm_metrics(params, pcm)
    dur = metrics["duration"]
    active = metrics["active"]
    bad = (
        dur <= 0.2
        or metrics["max"] < 500
        or metrics["rms"] < 90
        or active < min(0.75, dur * 0.20)
        or metrics["first_active"] > 2.0
    )
    return params, pcm, metrics, bad


def normalize_wav_blob(blob: bytes, *, chunk_index: int | None = None, min_keep_ratio: float = 0.55) -> bytes:
    params, pcm = read_wav_pcm(blob, chunk_index)
    pcm = trim_pcm_silence(params, pcm, min_keep_ratio=min_keep_ratio)
    channels, sampwidth, rate = params
    return wav_from_pcm(pcm, rate=rate, channels=channels, sampwidth=sampwidth)


def concat_wavs(blobs: list[bytes]) -> bytes:
    if not blobs:
        raise ValueError("no wav blobs to concatenate")
    first_params: tuple[int, int, int] | None = None
    all_pcm: list[bytes] = []
    for i, blob in enumerate(blobs):
        params, pcm = read_wav_pcm(blob, i + 1)
        if first_params is None:
            first_params = params
        elif params != first_params:
            raise ValueError(f"wav params mismatch at chunk {i}: {params} != {first_params}")
        # Chunks are already normalized/trimmed at generation time. Do not trim a
        # second time here: double-trimming caused audible chopped endings on
        # short dialogue segments.
        all_pcm.append(pcm)
        # Add a tiny safety join only for split/mixed audio. Keep it short: longer
        # gaps were audible as a regression after adding interview/clone routing.
        channels, sampwidth, rate = params
        silence_frames = int(rate * 0.02)
        all_pcm.append(b"\x00" * silence_frames * channels * sampwidth)
    assert first_params is not None
    channels, sampwidth, rate = first_params
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(b"".join(all_pcm))
    return out.getvalue()


def force_chunking_requested(payload: dict) -> bool:
    return payload.get("force_chunking") is True


class Handler(BaseHTTPRequestHandler):
    server_version = "qwentts-chunked-proxy/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def send_bytes(self, status: int, body: bytes, content_type: str) -> bool:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionResetError) as e:
            logging.warning("client disconnected while sending %d bytes: %s", len(body), e)
            return False

    def send_json(self, status: int, obj: Any) -> None:
        self.send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json")

    def do_GET(self) -> None:
        if self.path == "/health":
            status, headers, body = get_url(f"{BACKEND}/health")
            self.send_bytes(status, body, headers.get("content-type", "application/json"))
            return
        if self.path == "/v1/voices":
            status, headers, body = get_url(f"{BACKEND}/v1/voices")
            self.send_bytes(status, body, headers.get("content-type", "application/json"))
            return
        self.send_json(404, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            self.send_json(400, {"error": f"invalid json: {e}"})
            return

        text = str(payload.get("input") or "")
        force_chunking = force_chunking_requested(payload)
        requested_voice = str(payload.get("voice") or payload.get("speaker_1_voice") or "vivian").strip().lower()
        podcast_type = str(payload.get("podcast_type") or "").strip().lower()
        speaker_mode = str(payload.get("speaker_mode") or "").strip().lower()
        configs = payload.get("speakerVoiceConfigs") or payload.get("speaker_voice_configs") or []
        configured_voices = [str(payload.get("speaker_1_voice") or requested_voice), str(payload.get("speaker_2_voice") or "")]
        if isinstance(configs, list):
            configured_voices.extend(str(cfg.get("voice") or "") for cfg in configs if isinstance(cfg, dict))
        has_clone_voice = any(is_clone_voice(v) or str(v).strip().lower() == "voice-clone" for v in configured_voices)
        # Most Qwen preset voices are smoothest through the historical monolithic
        # path. Uncle Fu is the exception on long narration: with a high frame cap it
        # can return minutes of near-silence, so keep it on short bounded chunks.
        is_uncle_fu = requested_voice == "uncle_fu"
        is_single_speaker_qwen_preset = not has_clone_voice and (podcast_type == "narration" or speaker_mode in {"", "one"})
        is_qwen_single_speaker = is_single_speaker_qwen_preset and not is_uncle_fu and not force_chunking and len(" ".join(text.split())) <= QWEN_DIRECT_MAX_CHARS

        if is_qwen_single_speaker:
            # Regression guard: before the interview/clone work, Qwen narration was a
            # single backend call. Do not split/concat this path for normal Qwen preset
            # voices: chunk joins add audible short pauses compared with the original
            # smooth narration path.
            sub = dict(payload)
            sub.pop("force_chunking", None)
            sub.pop("one_sentence_per_chunk", None)
            sub["input"] = " ".join(text.split()).strip()
            sub["voice"] = requested_voice if is_valid_voice(requested_voice) and not is_clone_voice(requested_voice) else "vivian"
            sub["model"] = "qwen-tts"
            if not sub["input"]:
                self.send_json(400, {"error": "empty input"})
                return
            requested_max = int(payload.get("max_new_tokens") or 0)
            # Do not pass a 5-minute frame cap to a short script. qwentts keeps
            # generating after the text is exhausted, causing silence/noise tails.
            # qwentts frames are ~80 ms. Use a conservative per-text cap: enough to
            # finish a sentence, but still far below the old 5-minute monolith cap.
            length_cap = preset_narration_cap(sub["voice"], sub["input"])
            if requested_max > 0:
                sub["max_new_tokens"] = min(requested_max, length_cap)
            else:
                sub["max_new_tokens"] = length_cap
            logging.info("direct qwen single-speaker request chars=%d voice=%s requested_max=%s capped_max=%s", len(sub["input"]), sub["voice"], payload.get("max_new_tokens"), sub["max_new_tokens"])
            status, headers, body = post_json(f"{BACKEND}/v1/audio/speech", sub, timeout=REQUEST_TIMEOUT)
            ctype = headers.get("content-type", "audio/wav")
            if status == 200 and "audio" in ctype:
                body = normalize_wav_blob(body, chunk_index=1)
                dump_dir = new_chunk_dump_dir()
                dump_chunk_audio(dump_dir, index=1, total=1, speaker="narrateur", voice=sub["voice"], chunk=sub["input"], blob=body)
                self.send_bytes(200, body, "audio/wav")
            else:
                self.send_bytes(status, body, ctype)
            return

        segments = split_dialogue_segments(text, payload)
        chunks_with_voice: list[tuple[str, str, str]] = []
        split_max_chars = QWEN_PRESET_CHARS_PER_CHUNK if is_single_speaker_qwen_preset else MAX_CHARS_PER_CHUNK
        for seg in segments:
            for chunk in split_text(
                seg["text"],
                max_chars=split_max_chars,
                one_sentence_per_chunk=bool(payload.get("one_sentence_per_chunk")),
            ):
                chunks_with_voice.append((seg["speaker"], seg["voice"], chunk))
        if not chunks_with_voice:
            self.send_json(400, {"error": "empty input"})
            return

        # For mixed speakers/cloned speakers, synthesize each chunk with its mapped voice
        # and merge. Qwen-only single-speaker narration is handled above to preserve the
        # old smooth monolithic path.
        requested_max = int(payload.get("max_new_tokens") or 0)
        use_chunking = (
            force_chunking
            or len(chunks_with_voice) > 1
            or len(text) > MAX_CHARS_PER_CHUNK
            or requested_max > MAX_BACKEND_TOKENS_PER_CHUNK
            or len({voice for _, voice, _ in chunks_with_voice}) > 1
        )
        logging.info(
            "speech request chars=%d segments=%d chunks=%d chunking=%s voices=%s requested_max=%s",
            len(text), len(segments), len(chunks_with_voice), use_chunking,
            sorted({voice for _, voice, _ in chunks_with_voice}), requested_max,
        )

        if not use_chunking:
            sub = dict(payload)
            sub.pop("force_chunking", None)
            sub.pop("one_sentence_per_chunk", None)
            sub["input"] = chunks_with_voice[0][2]
            sub["voice"] = chunks_with_voice[0][1]
            if is_clone_voice(sub["voice"]) or sub["voice"] == "voice-clone":
                ref = clone_reference_for_voice(payload, chunks_with_voice[0][0], sub["voice"])
                if not ref:
                    self.send_json(400, {"error": "missing voice_clone_sample_path for cloned voice"})
                    return
                clone_engine = str(payload.get("tts_engine") or payload.get("model") or "qwen-tts-clone").strip().lower()
                sub["model"] = "fish-speech-local" if clone_engine in {"fish", "fish-audio", "fish-speech", "fish-speech-local"} else "qwen-tts-clone"
                sub["tts_engine"] = sub["model"]
                sub["voice_clone_sample_path"] = ref
                sub["reference_audio_path"] = ref
                if sub["model"] == "fish-speech-local":
                    sub["chunk_chars"] = min(240, max(120, int(len(sub["input"]) * 1.1)))
                    sub["max_chars"] = min(520, max(120, int(len(sub["input"]) * 1.25)))
                    fish_cap = max(110, min(340, int(len(sub["input"]) * 1.05)))
                    sub["max_new_tokens"] = min(requested_max, fish_cap) if requested_max > 0 else fish_cap
                backend_url = CLONE_BACKEND
                backend_timeout = CLONE_REQUEST_TIMEOUT
            else:
                if sub["voice"] == "uncle_fu":
                    sub["max_new_tokens"] = min(450, max(240, int(len(sub["input"]) * 1.15)))
                backend_url = BACKEND
                backend_timeout = REQUEST_TIMEOUT
            status, headers, body = post_json(f"{backend_url}/v1/audio/speech", sub, timeout=backend_timeout)
            ctype = headers.get("content-type", "audio/wav")
            if status == 200 and "pcm" in ctype.lower() and body[:4] != b"RIFF":
                body = wav_from_pcm(body)
                ctype = "audio/wav"
            self.send_bytes(status, body, ctype)
            return

        wavs: list[bytes] = []
        chunk_dump_dir = new_chunk_dump_dir()
        logging.info("chunk audio dump dir=%s retention=%ss", chunk_dump_dir, CHUNK_DUMP_RETENTION_SECONDS)
        started = time.time()
        for i, (speaker, voice, chunk) in enumerate(chunks_with_voice, 1):
            sub = dict(payload)
            sub.pop("force_chunking", None)
            sub.pop("one_sentence_per_chunk", None)
            sub["input"] = chunk
            sub["voice"] = voice
            if is_clone_voice(voice) or voice == "voice-clone":
                ref = clone_reference_for_voice(payload, speaker, voice)
                if not ref:
                    self.send_json(400, {"error": "missing voice_clone_sample_path for cloned voice", "chunk": i, "speaker": speaker, "voice": voice})
                    return
                clone_engine = str(payload.get("tts_engine") or payload.get("model") or "qwen-tts-clone").strip().lower()
                sub["model"] = "fish-speech-local" if clone_engine in {"fish", "fish-audio", "fish-speech", "fish-speech-local"} else "qwen-tts-clone"
                sub["tts_engine"] = sub["model"]
                sub["voice_clone_sample_path"] = ref
                sub["reference_audio_path"] = ref
                if sub["model"] == "fish-speech-local":
                    sub["chunk_chars"] = min(240, max(120, int(len(chunk) * 1.1)))
                    sub["max_chars"] = min(520, max(120, int(len(chunk) * 1.25)))
                    fish_cap = max(110, min(340, int(len(chunk) * 1.05)))
                    sub["max_new_tokens"] = min(requested_max, fish_cap) if requested_max > 0 else fish_cap
                else:
                    sub["max_chars"] = min(900, max(180, int(len(chunk) * 1.4)))
                backend_url = CLONE_BACKEND
                backend_timeout = CLONE_REQUEST_TIMEOUT
            else:
                sub["model"] = "qwen-tts"
                if is_single_speaker_qwen_preset:
                    # Long qwentts preset narration must be bounded per chunk; large
                    # frame caps drift into silence/noise after the spoken text ends.
                    sub["max_new_tokens"] = preset_narration_cap(voice, chunk)
                else:
                    # Dialogue/conversation chunks are often short turns. The old
                    # minimum of 450 frames forced ~36s generation for a 30–160 char
                    # reply, so qwentts continued after the spoken text with silence,
                    # hum or crackling. Bound preset voices by the actual turn length.
                    sub["max_new_tokens"] = preset_dialogue_cap(voice, chunk)
                backend_url = BACKEND
                backend_timeout = REQUEST_TIMEOUT
                sub["seed"] = preset_voice_seed_candidates(voice, sub.get("seed"))[0]
            logging.info("chunk %d/%d speaker=%s voice=%s backend=%s timeout=%ss chars=%d", i, len(chunks_with_voice), speaker, voice, backend_url, backend_timeout, len(chunk))
            status, headers, body = post_json(f"{backend_url}/v1/audio/speech", sub, timeout=backend_timeout)
            ctype = headers.get("content-type", "")
            if (is_clone_voice(voice) or voice == "voice-clone") and (status != 200 or "audio" not in ctype):
                logging.error(
                    "clone backend failed chunk %d speaker=%s voice=%s status=%s ctype=%s body=%r; refusing fake preset fallback",
                    i, speaker, voice, status, ctype, body[:500],
                )
                self.send_json(502, {"error": "clone backend failed", "chunk": i, "speaker": speaker, "voice": voice, "status": status, "body": body[:500].decode("utf-8", "replace")})
                return
            if status != 200 or "audio" not in ctype:
                logging.error("backend failed chunk %d status=%s ctype=%s body=%r", i, status, ctype, body[:500])
                self.send_json(502, {"error": "backend chunk failed", "chunk": i, "speaker": speaker, "voice": voice, "status": status, "body": body[:500].decode("utf-8", "replace")})
                return

            # qwentts preset voices can occasionally return a technically valid
            # audio blob that is silent/weak or starts after several seconds.
            # Ryan also stretches syllables if its frame cap is too high, so its
            # cap is handled above by preset_dialogue_cap(). Validate every preset
            # chunk before concatenation; never merge an inaudible turn.
            if backend_url == BACKEND and not is_clone_voice(voice):
                try:
                    _, _, metrics, bad = wav_quality(body, i)
                    min_keep = 0.20 if voice in FRAGILE_PRESET_VOICES else 0.35
                    trimmed_body = normalize_wav_blob(body, chunk_index=i, min_keep_ratio=min_keep)
                    _, _, trimmed_metrics, trimmed_bad = wav_quality(trimmed_body, i)
                    if not trimmed_bad and (bad or trimmed_metrics["duration"] < metrics["duration"] - 0.25):
                        logging.info(
                            "preset voice trim chunk=%d voice=%s dur %.2f->%.2f active %.2f->%.2f first %.2f->%.2f rms %.0f->%.0f",
                            i, voice,
                            metrics["duration"], trimmed_metrics["duration"],
                            metrics["active"], trimmed_metrics["active"],
                            metrics["first_active"], trimmed_metrics["first_active"],
                            metrics["rms"], trimmed_metrics["rms"],
                        )
                        body = trimmed_body
                        metrics = trimmed_metrics
                        bad = False
                    if bad:
                        retry_seeds = preset_voice_seed_candidates(voice, payload.get("seed"))
                        base_cap = preset_dialogue_cap(voice, chunk)
                        retry_caps = [base_cap]
                        if voice != "ryan":
                            retry_caps.append(max(base_cap + 25, min(150, max(70, int(len(chunk) * 1.10)))))
                            if voice in FRAGILE_PRESET_VOICES:
                                retry_caps.append(max(base_cap, min(120, int(len(chunk) * 0.95))))
                        retry_caps = unique_ints(retry_caps)
                        logging.warning(
                            "preset voice weak chunk=%d voice=%s metrics=%s; retry seeds=%s caps=%s",
                            i, voice, metrics, retry_seeds, retry_caps,
                        )
                        attempts = 0
                        max_attempts = 6 if voice in FRAGILE_PRESET_VOICES else 4
                        for retry_seed in retry_seeds:
                            for retry_cap in retry_caps:
                                if attempts >= max_attempts:
                                    break
                                # Avoid exactly repeating the already-failed first request.
                                if int(sub.get("seed") or 0) == retry_seed and int(sub.get("max_new_tokens") or 0) == retry_cap:
                                    continue
                                attempts += 1
                                retry = dict(sub)
                                retry["max_new_tokens"] = retry_cap
                                retry["temperature"] = min(float(retry.get("temperature") or 0.15), 0.12)
                                retry["top_p"] = min(float(retry.get("top_p") or 0.8), 0.75)
                                retry["seed"] = retry_seed
                                status2, headers2, body2 = post_json(f"{BACKEND}/v1/audio/speech", retry, timeout=REQUEST_TIMEOUT)
                                ctype2 = headers2.get("content-type", "")
                                if status2 == 200 and "audio" in ctype2:
                                    body2 = normalize_wav_blob(body2, chunk_index=i, min_keep_ratio=min_keep)
                                    _, _, metrics2, bad2 = wav_quality(body2, i)
                                    logging.info("preset voice retry chunk=%d voice=%s seed=%s cap=%s metrics=%s bad=%s", i, voice, retry_seed, retry_cap, metrics2, bad2)
                                    if not bad2:
                                        status, headers, body, ctype = status2, headers2, body2, "audio/wav"
                                        bad = False
                                        break
                            if attempts >= max_attempts or not bad:
                                break
                    if bad:
                        fallback_voice = preset_fallback_voice(voice, speaker)
                        fallback = dict(sub)
                        fallback["voice"] = fallback_voice
                        fallback["model"] = "qwen-tts"
                        fallback["max_new_tokens"] = preset_dialogue_cap(fallback_voice, chunk)
                        fallback["temperature"] = 0.12
                        fallback["top_p"] = 0.75
                        logging.warning("preset voice fallback chunk=%d voice=%s -> %s metrics=%s", i, voice, fallback_voice, metrics)
                        status2, headers2, body2 = post_json(f"{BACKEND}/v1/audio/speech", fallback, timeout=REQUEST_TIMEOUT)
                        ctype2 = headers2.get("content-type", "")
                        if status2 == 200 and "audio" in ctype2:
                            status, headers, body, ctype = status2, headers2, normalize_wav_blob(body2, chunk_index=i, min_keep_ratio=0.35), "audio/wav"
                except Exception:
                    logging.exception("preset voice quality guard failed chunk=%d voice=%s; keeping original audio", i, voice)
                # Always dump/concat a real RIFF WAV. qwentts sometimes returns raw
                # audio/pcm even when the HTTP content type says audio/*.
                body = normalize_wav_blob(body, chunk_index=i)
            dump_chunk_audio(chunk_dump_dir, index=i, total=len(chunks_with_voice), speaker=speaker, voice=voice, chunk=chunk, blob=body)
            wavs.append(body)

        try:
            merged = concat_wavs(wavs)
        except Exception as e:
            logging.exception("concat failed")
            self.send_json(500, {"error": f"concat failed: {e}"})
            return
        logging.info("merged chunks=%d bytes=%d elapsed=%.1fs", len(wavs), len(merged), time.time() - started)
        self.send_bytes(200, merged, "audio/wav")


def main() -> int:
    cleanup_old_chunk_dumps()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    logging.info("listening on %s:%d, backend=%s", HOST, PORT, BACKEND)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
