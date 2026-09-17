# Ani Companion

[Français](README.MD) | **English**

Ani Companion is a local PWA that provides a companion interface with a VRM avatar, speech transcription, local text generation, and text-to-speech. The repository contains the FastAPI server, web client, Qwen-TTS chunking proxy, systemd units, and Ollama `Modelfile` files.

## Project media

The included media files are versioned in [`static/media/`](static/media/) so the application can serve them directly:

- `ani-companion-portrait.png`: screenshot of the interface in portrait mode;
- `ani-companion-demo-01.mp4` and `ani-companion-demo-02.mp4`: demo recordings converted from the original MOV files.

![Ani Companion — portrait mode](static/media/ani-companion-portrait.png)

### Demo 1

https://github.com/user-attachments/assets/f94e63d7-92ab-4e7b-b661-4783ab6078bd

### Demo 2

https://github.com/user-attachments/assets/889105c5-50ff-4b90-a069-dd9dff41f495

Both videos are encoded in H.264 with `CRF 40` and the `slow` preset, while preserving their AAC audio tracks. The source MOV files remain in the user's home directory and are not required to run the application.

The target architecture is:

```text
Browser
  ├─ Web Speech API / Whisper (transcription, depending on the selected client)
  └─ HTTP → ani-companion :8787
                 ├─ Hermes Agent → Ollama :11434 → Ani model
                 └─ Qwen proxy :15004 → qwentts.cpp :15003
```

Tailscale is optional and is only used to expose the interface remotely. Without Tailscale, the application remains available locally at `127.0.0.1:8787`.

## Hardware requirements

A recent Linux machine is recommended. You will need:

- Python 3.11 or newer;
- Node.js and npm to build the client;
- a GPU supported by Ollama and Qwen-TTS, or enough RAM/VRAM for slow CPU execution;
- several dozen gigabytes of free space for the models;
- `git`, `curl`, `ffmpeg`, and `systemd`.

Model tags are installation-specific. Always check the tags actually available with `ollama list` before creating an alias.

## Setup guide for a clean machine

### 1. Install system packages

Arch Linux example:

```bash
sudo pacman -Syu --needed git python nodejs npm curl ffmpeg
```

On Debian or Ubuntu, install the equivalent packages (`git python3 python3-venv nodejs npm curl ffmpeg`). GPU driver installation depends on your hardware; install and test the driver recommended by its manufacturer first.

### 2. Clone the repository

```bash
git clone <REPOSITORY_URL> ~/ani-companion
cd ~/ani-companion
```

The units included in `ops/` use `/home/francois/projects/ani-companion`. If you install the project elsewhere, update the paths in the units before copying them to `/etc/systemd/system/`.

### 3. Create the Python environment

```bash
cd ~/ani-companion
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install fastapi uvicorn httpx python-multipart
```

The Qwen proxy is intentionally a standard Python script; `qwentts.cpp` installs its own dependencies. If a later repository version adds a `requirements.txt` file, install it in the same environment with `python -m pip install -r requirements.txt`.

### 4. Install Ollama

Install Ollama from its official documentation, then enable its service:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
systemctl status ollama
curl http://127.0.0.1:11434/api/tags
```

Download the base model appropriate for your machine. The versioned `Modelfile` files are in `models/`:

```bash
ollama pull gemma4:latest
ollama create ani-gemma4:latest -f models/Modelfile.ani-gemma4
ollama list
```

For the twelve-billion-parameter variant:

```bash
ollama pull gemma4:12b
ollama create ani-gemma4-12b:latest -f models/Modelfile.ani-gemma4-12b
```

A Qwen alternative is also included:

```bash
ollama pull qwen3:latest
ollama create ani-qwen:latest -f models/Modelfile.ani-qwen
```

If the Ollama registry uses a different base-model name, change only the `FROM` line in the `Modelfile`, then rebuild the alias. The application server must use the same name configured in its systemd unit.

### 5. Install Hermes Agent

Install Hermes Agent according to its official documentation, then confirm that its Python environment is available. Ani uses a profile separate from the default profile:

```bash
export HERMES_HOME="$HOME/.hermes/profiles/ani"
hermes --help
```

The custom provider must be configured to connect to Ollama locally. Check the `ani` profile configuration with the commands supported by your Hermes version; do not copy configuration from the default profile without checking its paths. The model recommended by this version is `ani-gemma4:latest` (the repository's legacy service also mentions `ani-gemma4-12b:latest`).

### 6. Install Qwen-TTS and qwentts.cpp

Qwen-TTS is the text-to-speech engine. `qwentts.cpp` must provide the local backend on `127.0.0.1:15003`. The repository proxy listens on `127.0.0.1:15004`, splits long text into chunks, and exposes an OpenAI-compatible API.

Install and test `qwentts.cpp` according to its documentation, then verify its endpoint. You can start the proxy manually for an initial test:

```bash
cd ~/ani-companion
. .venv/bin/activate
python ops/qwentts-chunked-proxy.py
curl -I http://127.0.0.1:15004/health
```

The voices used by the application are defined in `avatars.json` (`Nuna` for François and `Serena` for Salomé). Confirm that these voices are available in your Qwen-TTS installation.

### 7. Add Whisper (optional, depending on the browser)

The client can use the browser's speech recognition. For reproducible local transcription, install a Whisper server compatible with the contract expected by your client, such as `whisper.cpp` or `faster-whisper`, and store its models in a persistent directory. Test its endpoint before connecting it to the PWA.

Whisper is not started by `app.py` itself. Its systemd unit must therefore be supplied by the selected Whisper server or adapted locally. Do not start an example unit with a placeholder path; replace `ExecStart` with the exact command for your installation and verify the endpoint with `curl`.

### 8. Build the client and run the application

```bash
cd ~/ani-companion
npm ci
npm run build
```

To test the bundle during development, run `npm run build` directly. The repository does not include a separate development server; serve the directory through the FastAPI application or a suitable static server.

To test the backend without systemd:

```bash
. .venv/bin/activate
HERMES_HOME="$HOME/.hermes/profiles/ani" \
  uvicorn app:app --host 127.0.0.1 --port 8787
```

Then open `http://127.0.0.1:8787`.

## systemd services

### Ollama

The official script normally installs `ollama.service`:

```bash
sudo systemctl enable --now ollama
journalctl -u ollama -f
```

### Qwen proxy

The unit ready to be adapted is `ops/qwentts-proxy.service`. It assumes that `qwentts.cpp` is already listening on port `15003` and that the proxy listens on `15004`.

```bash
sudo cp ops/qwentts-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qwentts-proxy
sudo systemctl status qwentts-proxy
curl http://127.0.0.1:15004/health
```

At a minimum, update `User`, `WorkingDirectory`, and `ExecStart`. The script currently hardcodes ports `15003` and `15004`; the unit's environment variables do not override these constants.

### Ani Companion

Adapt and install `ops/ani-companion.service`:

```bash
sudoedit ops/ani-companion.service
sudo cp ops/ani-companion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ani-companion
sudo systemctl status ani-companion
journalctl -u ani-companion -f
```

The important variables are:

- `HERMES_HOME`: isolated Hermes profile;
- `ANI_HERMES_MODEL`: Ollama alias created earlier;
- `ANI_HERMES_PROVIDER=custom`: local provider;
- `ANI_QWEN_TTS_URL=http://127.0.0.1:15004/v1/audio/speech`;
- `ANI_QWEN_TTS_VOICE`: default voice;
- `ANI_HERMES_TOOLSETS`: enabled Hermes tools.

The unit listens only on `127.0.0.1`. This is intentional: a reverse proxy or Tailscale can be placed in front of it without exposing Uvicorn directly to the network.

### Whisper

Enable the systemd unit supplied by the selected Whisper project, then check it independently:

```bash
sudo systemctl enable --now whisper
sudo systemctl status whisper
journalctl -u whisper -f
```

The exact service name and endpoint vary between `whisper.cpp` and `faster-whisper`. Keep the service separate so that restarting transcription does not restart Ani Companion.

## Tailscale (optional)

Tailscale is not required for local use. For remote access:

```bash
sudo pacman -S tailscale       # or your distribution's package
sudo systemctl enable --now tailscaled
sudo tailscale up
tailscale status
```

Then expose the local port using your preferred method (`tailscale serve`, a reverse proxy, or a tunnel). Restrict access to your tailnet, and do not expose the Uvicorn port on `0.0.0.0` without authentication and TLS.

## End-to-end checks

```bash
curl http://127.0.0.1:11434/api/tags
curl http://127.0.0.1:15003/health
curl http://127.0.0.1:15004/health
curl http://127.0.0.1:8787/api/health
npm test
```

Then test profile selection, transcription, text responses, TTS playback, and—if enabled—remote access through Tailscale in the browser. If something fails, start with `journalctl -u ollama`, `journalctl -u qwentts-proxy`, and `journalctl -u ani-companion`; diagnose each service independently.

## Development

```bash
npm ci
npm test
```

Do not commit downloaded models, secrets, session logs, or temporary files. The `Modelfile` files are reproducible recipes; Ollama and Qwen-TTS continue to manage the model weights.
