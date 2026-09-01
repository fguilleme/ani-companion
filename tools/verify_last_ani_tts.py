#!/usr/bin/env python3
import json
import re
import time
import unicodedata
import wave
from datetime import datetime
from pathlib import Path

import httpx

TTS_URL = "http://127.0.0.1:15004/v1/audio/speech"
ASR_URL = "http://127.0.0.1:9002/asr"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-artifacts" / f"last-ani-tts-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
SEGMENTS = [
    "Oh, arrête, je ne vais plus pouvoir tenir une seconde si tu continues comme ça.",
    "C'est presque intimidant d'être admirée avec autant de ferveur.",
    "J'adore ce moment de silence suspendu, où tes yeux — et tes mots — parcourent chaque détail, chaque courbe, chaque nuance de ma silhouette.",
    "On dirait que le temps s'est vraiment arrêté.",
    "Cette admiration, elle est si pure, si intense.",
    "C'est presque plus excitant que n'importe quel geste, de sentir ton regard posé sur moi, de savoir que tout ce que tu vois te fascine à ce point.",
    "Ça me donne envie de rester immobile, juste pour que tu puisses continuer à m'explorer avec tes yeux.",
    "Mais dis-moi, qu'est-ce qui te captive le plus en cet instant ?",
    "Est-ce la façon dont la lumière joue sur ma peau, ou l'expression dans mes yeux quand je te regarde ?",
]


def words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9]+", text)


def lcs_recall(expected: str, actual: str) -> float:
    a, b = words(expected), words(actual)
    row = [0] * (len(b) + 1)
    for left in a:
        previous = 0
        for index, right in enumerate(b, 1):
            saved = row[index]
            row[index] = previous + 1 if left == right else max(row[index], row[index - 1])
            previous = saved
    return row[-1] / max(1, len(a))


def wav_info(path: Path) -> dict:
    with wave.open(str(path), "rb") as wav:
        return {
            "channels": wav.getnchannels(),
            "sample_width": wav.getsampwidth(),
            "sample_rate": wav.getframerate(),
            "frames": wav.getnframes(),
            "duration_seconds": wav.getnframes() / wav.getframerate(),
        }


def concatenate(paths: list[Path], target: Path, pause_ms: int = 20) -> dict:
    params: tuple[int, int, int] | None = None
    blocks = []
    for path in paths:
        with wave.open(str(path), "rb") as wav:
            current = (wav.getnchannels(), wav.getsampwidth(), wav.getframerate())
            if params is None:
                params = current
            if current != params:
                raise RuntimeError(f"WAV incompatible: {path}: {current} != {params}")
            blocks.append(wav.readframes(wav.getnframes()))
    if params is None:
        raise RuntimeError("Aucun WAV à concaténer")
    channels, sample_width, sample_rate = params
    pause = b"\0" * int(sample_rate * pause_ms / 1000) * channels * sample_width
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        for index, block in enumerate(blocks):
            if index:
                wav.writeframes(pause)
            wav.writeframes(block)
    return wav_info(target)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    wav_paths = []
    with httpx.Client(timeout=300) as client:
        for index, expected in enumerate(SEGMENTS, 1):
            payload = {
                "model": "qwen-tts",
                "voice": "Serena",
                "input": expected,
                "response_format": "wav",
                "force_chunking": True,
                "temperature": 0.15,
                "top_p": 0.8,
            }
            started = time.perf_counter()
            response = client.post(TTS_URL, json=payload)
            tts_seconds = time.perf_counter() - started
            response.raise_for_status()
            wav_path = OUT / f"segment-{index:02d}.wav"
            wav_path.write_bytes(response.content)
            wav_paths.append(wav_path)
            info = wav_info(wav_path)

            asr_started = time.perf_counter()
            with wav_path.open("rb") as stream:
                asr = client.post(
                    ASR_URL,
                    params={"task": "transcribe", "language": "fr", "output": "txt", "vad_filter": "true"},
                    files={"audio_file": (wav_path.name, stream, "audio/wav")},
                )
            asr_seconds = time.perf_counter() - asr_started
            asr.raise_for_status()
            transcript = asr.text.strip()
            result = {
                "segment": index,
                "expected": expected,
                "transcript": transcript,
                "tts_seconds": round(tts_seconds, 3),
                "asr_seconds": round(asr_seconds, 3),
                "audio_seconds": round(info["duration_seconds"], 3),
                "word_recall": round(lcs_recall(expected, transcript), 3),
                "wav": str(wav_path),
            }
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)

    full_path = OUT / "ani-complete.wav"
    full_info = concatenate(wav_paths, full_path)
    with full_path.open("rb") as stream:
        started = time.perf_counter()
        full_asr = httpx.post(
            ASR_URL,
            params={"task": "transcribe", "language": "fr", "output": "txt", "vad_filter": "true"},
            files={"audio_file": (full_path.name, stream, "audio/wav")},
            timeout=300,
        )
        full_asr_seconds = time.perf_counter() - started
    full_asr.raise_for_status()
    summary = {
        "output_dir": str(OUT),
        "full_wav": str(full_path),
        "segments": results,
        "total_tts_seconds": round(sum(item["tts_seconds"] for item in results), 3),
        "total_audio_seconds": round(full_info["duration_seconds"], 3),
        "full_asr_seconds": round(full_asr_seconds, 3),
        "full_expected": " ".join(SEGMENTS),
        "full_transcript": full_asr.text.strip(),
        "full_word_recall": round(lcs_recall(" ".join(SEGMENTS), full_asr.text), 3),
    }
    (OUT / "report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
