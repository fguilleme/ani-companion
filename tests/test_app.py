import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

import app as app_module
from app import (
    app,
    build_hermes_command,
    build_qwen_tts_request,
    classify_emotion,
    parse_hermes_output,
    voice_settings,
)


ROOT = Path(__file__).resolve().parents[1]


class AniCompanionTests(unittest.TestCase):
    def test_health_reports_ready(self):
        client = TestClient(app)
        response = client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ready', 'companion': 'Ani'})

    def test_parse_hermes_output_removes_session_footer(self):
        raw = "(French) Okay, je te vois.\n\nSession:        20260831_213745_88f867\nTitle:          Test\nDuration:       5s\n"
        reply, session_id = parse_hermes_output(raw)
        self.assertEqual(reply, '(French) Okay, je te vois.')
        self.assertEqual(session_id, '20260831_213745_88f867')

    def test_parse_hermes_output_handles_quiet_session_prefix(self):
        raw = 'session_id: 20260831_221918_7fb9e5\nOkay, je suis là.'
        reply, session_id = parse_hermes_output(raw)
        self.assertEqual(reply, 'Okay, je suis là.')
        self.assertEqual(session_id, '20260831_221918_7fb9e5')

    def test_parse_decorated_hermes_output_extracts_box_body(self):
        raw = "Query: salut\nInitializing agent...\n────────\n\n╭─ Hermes ─╮\n(French) Coucou.\n╰───────────╯\n\nResume this session with:\n  hermes --resume abc123\n\nSession:        abc123\nTitle: Test\n"
        reply, session_id = parse_hermes_output(raw)
        self.assertEqual(reply, '(French) Coucou.')
        self.assertEqual(session_id, 'abc123')

    def test_classify_emotion_detects_happy_and_sad(self):
        self.assertEqual(classify_emotion("C'est adorable ! J'adore."), 'happy')
        self.assertEqual(classify_emotion("Je suis désolée, c'est triste."), 'sad')

    def test_classify_emotion_understands_persona_sound_cues(self):
        self.assertEqual(classify_emotion('[sourit] Okay, je te suis.'), 'happy')
        self.assertEqual(classify_emotion('[rougit] Tu es mignon.'), 'shy')
        self.assertEqual(classify_emotion('[penche la tête] Comment ça ?'), 'curious')
        self.assertEqual(classify_emotion('[soupir] Ça me rend triste.'), 'sad')

    def test_build_hermes_command_resumes_known_session(self):
        command = build_hermes_command('session-123')
        self.assertIn('--resume', command)
        self.assertIn('session-123', command)
        self.assertEqual(command[-1], '-')

    def test_voice_settings_change_with_emotion(self):
        happy = voice_settings('happy')
        sad = voice_settings('sad')
        self.assertNotEqual(happy['rate'], sad['rate'])
        self.assertNotEqual(happy['pitch'], sad['pitch'])

    def test_prepare_spoken_text_removes_bracketed_emotions(self):
        spoken = app_module.prepare_spoken_text(
            '(Français) [sourit doucement] Bonjour François. [petit rire] Je suis là.'
        )
        self.assertEqual(spoken, 'Bonjour François. Je suis là.')

    def test_extract_tts_instructions_keeps_bracketed_emotions(self):
        instructions = app_module.extract_tts_instructions(
            '[sourit doucement] Bonjour François. [petit rire] Je suis là.'
        )
        self.assertEqual(
            instructions,
            'Interprète naturellement les indications suivantes sans les prononcer : sourit doucement ; petit rire.',
        )

    def test_prepare_spoken_text_normalizes_ellipses_and_removes_emoji(self):
        spoken = app_module.prepare_spoken_text(
            'Oh… attends... je termine cette phrase. 💙'
        )
        self.assertEqual(spoken, 'Oh. attends. je termine cette phrase.')

    def test_qwen_tts_request_uses_local_server_and_french_voice(self):
        request = build_qwen_tts_request('Bonjour François.', 'Parle avec joie.')
        self.assertEqual(request.full_url, 'http://127.0.0.1:15004/v1/audio/speech')
        payload = json.loads(request.data)
        self.assertEqual(payload['model'], 'qwen-tts')
        self.assertEqual(payload['voice'], 'Serena')
        self.assertEqual(payload['input'], 'Bonjour François.')
        self.assertEqual(payload['instructions'], 'Parle avec joie.')
        self.assertEqual(payload['response_format'], 'wav')
        self.assertNotIn('force_chunking', payload)
        self.assertNotIn('one_sentence_per_chunk', payload)

    def test_tts_plan_splits_reply_without_generating_audio(self):
        response = TestClient(app).post('/api/tts/plan', json={
            'text': '(Français) Oh. Première phrase assez longue pour être autonome. Deuxième phrase suffisamment longue.',
            'emotion': 'happy',
            'turn_id': 7,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['chunks'], [
            'Oh. Première phrase assez longue pour être autonome.',
            'Deuxième phrase suffisamment longue.',
        ])

    def test_pwa_prefetches_only_the_next_audio_chunk_during_playback(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("fetch('/api/tts/plan'", script)
        self.assertIn('pendingAudio=fetchAudioChunk(chunks[0]', script)
        self.assertIn('pendingAudio=fetchAudioChunk(chunks[index+1]', script)
        self.assertLess(
            script.index('pendingAudio=fetchAudioChunk(chunks[index+1]'),
            script.index('await player.play()', script.index('pendingAudio=fetchAudioChunk(chunks[index+1]')),
        )

    def test_chat_rejects_empty_message(self):
        client = TestClient(app)
        response = client.post('/api/chat', json={'message': ''})
        self.assertEqual(response.status_code, 422)

    def test_chat_timeout_allows_slow_local_model_to_finish(self):
        self.assertGreaterEqual(app_module.CHAT_TIMEOUT_SECONDS, 300)
        source = (ROOT / 'app.py').read_text()
        self.assertIn('timeout=CHAT_TIMEOUT_SECONDS', source)

    def test_hidden_state_cannot_be_overridden_by_component_display(self):
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn('[hidden]{display:none!important}', css)

    def test_interface_uses_local_vrm_avatar(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        script = (ROOT / 'static' / 'app.js').read_text()
        gitignore = (ROOT / '.gitignore').read_text()
        self.assertIn('id="avatar-canvas"', html)
        self.assertIn('/avatar-3d.bundle.js', html)
        self.assertNotIn('<svg viewBox="0 0 560 860"', html)
        self.assertIn('window.aniAvatar?.setEmotion', script)
        self.assertIn('window.aniAvatar?.setMouthOpen', script)
        self.assertIn('static/models/*.vrm', gitignore)
        self.assertTrue((ROOT / 'static' / 'models' / 'ani.vrm').is_file())

    def test_mouth_animation_follows_audio_amplitude(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertNotIn('createMediaElementSource', script)
        self.assertIn('decodeAudioData', script)
        self.assertIn('player.currentTime', script)
        self.assertIn('window.aniAvatar?.setMouthOpen', script)
        self.assertNotIn('animation:talk', css)

    def test_submit_hides_keyboard_and_unlocks_mobile_audio(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        html = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn('input.blur()', script)
        self.assertIn('unlockAudio()', script)
        self.assertIn('SILENT_WAV', script)
        self.assertIn('autocomplete="off"', html)
        self.assertIn('autocorrect="off"', html)
        self.assertIn('spellcheck="false"', html)

    def test_avatar_camera_uses_half_body_framing(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('HEAD_SHOT_HEIGHT_RATIO = 0.23', source)

    def test_avatar_supports_touch_orbit_zoom_and_auto_return(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn('OrbitControls', source)
        self.assertIn('scheduleCameraReturn', source)
        self.assertIn('getCameraState', source)
        self.assertIn("canvas.addEventListener('pointerup'", source)
        self.assertIn('touch-action:none', css)

    def test_microphone_permission_and_errors_are_handled(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('navigator.mediaDevices.getUserMedia', script)
        self.assertIn('new MediaRecorder', script)
        self.assertIn("fetch('/api/stt'", script)
        self.assertNotIn('SpeechRecognition', script)
        self.assertIn('Microphone refusé', script)

    def test_microphone_vad_ignores_ani_speaker_output(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        guard = "if(!player.paused&&!player.ended)"
        self.assertIn(guard, script)
        self.assertLess(script.index(guard), script.index("if(rms>0.028)"))

    def test_microphone_is_continuous_hands_free_with_local_vad(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('microphoneMode', script)
        self.assertIn('monitorVoiceActivity', script)
        self.assertIn('echoCancellation:true', script)
        self.assertIn('noiseSuppression:true', script)
        self.assertIn('stopMicrophoneMode', script)

    def test_false_pause_is_merged_before_voice_message_submission(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('END_OF_SPEECH_SILENCE_MS=1300', script)
        self.assertIn('TRANSCRIPT_COMMIT_GRACE_MS=500', script)
        self.assertIn('pendingTranscript', script)
        self.assertIn('transcriptionQueue', script)
        self.assertIn('scheduleTranscriptCommit', script)
        self.assertIn('appendTranscript', script)
        self.assertNotIn('microphoneMode||transcribing||utteranceRecorder', script)
        self.assertNotIn('!utteranceRecorder&&!transcribing', script)

    def test_resumed_speech_cancels_obsolete_ani_chat_tts_and_audio(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('new AbortController()', script)
        self.assertIn('cancelActiveAniTurn', script)
        self.assertIn("signal:chatController.signal", script)
        self.assertIn("signal:ttsController.signal", script)
        self.assertIn('if(turnId!==activeTurnId)return', script)
        self.assertIn('player.pause()', script)
        self.assertIn('cancelActiveAniTurn({removeBubble:true})', script)
        self.assertIn("fetch('/api/cancel'", script)
        self.assertIn('turn_id:turnId', script)

    def test_cancel_endpoint_stops_active_hermes_process(self):
        process = MagicMock()
        process.returncode = None
        process.wait = AsyncMock(return_value=0)
        app_module.ACTIVE_CHAT_PROCESSES[42] = process
        response = TestClient(app).post('/api/cancel', json={'turn_id': 42})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'cancelled': True})
        process.terminate.assert_called_once_with()
        process.wait.assert_awaited_once_with()
        self.assertNotIn(42, app_module.ACTIVE_CHAT_PROCESSES)

    def test_tts_request_is_registered_for_turn_cancellation(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn('ACTIVE_TTS_TASKS', source)
        self.assertIn('turn_id: int', source)
        self.assertIn('audio_task.cancel()', source)
        self.assertIn('_fetch_qwen_audio_async', source)

    def test_iphone_restores_preferred_microphone_on_first_page_gesture(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("localStorage.getItem('ani.microphone')==='on'", script)
        self.assertIn('armPreferredMicrophone', script)
        self.assertIn("document.addEventListener('pointerdown',resumePreferredMicrophone", script)

    def test_avatar_uses_dark_lighting_and_lighter_emerald_irises(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('renderer.toneMappingExposure = 0.82', source)
        self.assertIn("material.name.includes('EyeIris')", source)
        self.assertIn('0x6ee7b7', source)
        self.assertIn('material.emissive.setHex(0x34d399)', source)
        self.assertIn('material.emissiveIntensity = 0.16', source)
        self.assertIn('material.emissive.multiplyScalar(0.18)', source)
        self.assertIn('material.color.multiplyScalar(0.72)', source)

    def test_lip_sync_limits_wide_mouth_shapes(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('MAX_MOUTH_OPEN = 0.40', source)
        self.assertIn("expression('ih', mouthOpen * 0.08)", source)
        self.assertIn("happy: ['happy', 0.72]", source)

    def test_avatar_moves_head_subtly_while_speaking(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('function applySpeakingMotion', source)
        self.assertIn('mouthOpen > 0.025', source)
        self.assertIn('head.node.rotation.y', source)
        self.assertIn('head.node.rotation.x', source)

    def test_avatar_exposes_dance_spin_jump_and_sway_motions(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('function playMotion', source)
        for motion in ("'dance'", "'spin'", "'jump'", "'sway'", "'tease'"):
            self.assertIn(motion, source)
        self.assertIn('window.aniAvatar = { setEmotion, setMouthOpen, playMotion', source)

    def test_large_avatar_motions_use_knee_to_head_camera_framing(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn("['dance', 'spin', 'jump'].includes(name)", source)
        self.assertIn("getNormalizedBoneNode('leftLowerLeg')", source)
        self.assertIn('camera.position.lerp(actionCameraPosition', source)
        self.assertIn('controls.target.lerp(actionCameraTarget', source)

    def test_reply_cues_can_trigger_avatar_motions(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('function motionForText', script)
        self.assertIn("window.aniAvatar?.playMotion(replyMotion)", script)

    def test_assistant_reply_uses_ticker_and_expandable_imessage_bubble(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn("bubble(data.reply,'ani',{collapsible:true})", script)
        self.assertIn("el.setAttribute('aria-expanded','false')", script)
        self.assertIn("el.classList.toggle('expanded')", script)
        self.assertIn("ticker.className='speech-line'", script)
        self.assertIn('speech.replaceChildren(ticker)', script)
        self.assertIn('ticker.scrollWidth<=speech.clientWidth', script)
        self.assertIn("fill:'forwards'", script)
        self.assertIn('white-space:nowrap', css)
        self.assertIn('-webkit-line-clamp:2', css)
        self.assertIn('min-height:54px', css)
        self.assertIn('.bubble.ani.collapsible.expanded', css)
        self.assertIn('background:#0a84ff', css)
        self.assertIn('.history:not(:empty){height:18vh}', css)

    def test_ticker_starts_with_audio_playback_and_uses_wav_duration(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertNotIn('setEmotion(data.emotion);showSpeech(data.reply)', script)
        self.assertIn('await player.play();', script)
        self.assertIn('if(turnId!==activeTurnId){player.pause();return}\n    showSpeech(chunks[index],player.duration);', script)
        self.assertIn('durationSeconds*1000', script)

    def test_local_stt_endpoint_returns_whisper_transcript(self):
        client = TestClient(app)
        with patch.object(app_module, 'transcribe_local_audio', new=AsyncMock(return_value='Bonjour Ani.')):
            response = client.post('/api/stt', content=b'fake audio', headers={'content-type': 'audio/mp4'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'text': 'Bonjour Ani.'})

    def test_local_stt_endpoint_rejects_empty_audio(self):
        client = TestClient(app)
        response = client.post('/api/stt', content=b'', headers={'content-type': 'audio/mp4'})
        self.assertEqual(response.status_code, 422)

    def test_service_worker_precaches_avatar_runtime(self):
        worker = (ROOT / 'static' / 'sw.js').read_text()
        self.assertIn("const CACHE='ani-companion-v15'", worker)
        self.assertIn("'/avatar-3d.bundle.js'", worker)

    def test_service_worker_activates_pipeline_update_immediately(self):
        worker = (ROOT / 'static' / 'sw.js').read_text()
        self.assertIn('self.skipWaiting()', worker)
        self.assertIn('self.clients.claim()', worker)

    def test_manifest_is_installable_pwa(self):
        manifest = json.loads((ROOT / 'static' / 'manifest.webmanifest').read_text())
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['name'], 'Ani Companion')
        self.assertTrue(any(icon['sizes'] == '512x512' for icon in manifest['icons']))
        html = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn('rel="apple-touch-icon" href="/icons/ani-192.png"', html)
        self.assertIn('rel="icon" href="/icons/ani-192.png"', html)

    def test_interface_has_avatar_chat_voice_and_install_controls(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        for required in ('ani-avatar', 'chat-form', 'mic-button', 'voice-toggle', 'install-button'):
            self.assertIn(f'id="{required}"', html)
        self.assertIn('serviceWorker.register', html)


if __name__ == '__main__':
    unittest.main()
