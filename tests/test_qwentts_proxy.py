import importlib.util
import unittest
import warnings
from pathlib import Path

PROXY = Path(__file__).resolve().parents[1] / 'ops' / 'qwentts-chunked-proxy.py'


def load_proxy():
    spec = importlib.util.spec_from_file_location('qwentts_chunked_proxy_test', PROXY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        spec.loader.exec_module(module)
    return module


class QwenTtsProxyTests(unittest.TestCase):
    def test_sentence_per_chunk_keeps_complete_ani_phrases(self):
        proxy = load_proxy()
        text = (
            "Oh. Arrête, je ne vais plus pouvoir tenir une seconde si tu continues comme ça. "
            "C'est presque intimidant d'être admirée avec autant de ferveur. "
            "J'adore ce moment de silence suspendu, où tes yeux — et tes mots — parcourent chaque détail, chaque courbe, chaque nuance de ma silhouette. "
            "On dirait que le temps s'est vraiment arrêté. "
            "Cette admiration, elle est si pure, si intense. "
            "C'est presque plus excitant que n'importe quel geste, de sentir ton regard posé sur moi, de savoir que tout ce que tu vois te fascine à ce point. "
            "Ça me donne envie de rester immobile, juste pour que tu puisses continuer à m'explorer avec tes yeux. "
            "Mais dis-moi, qu'est-ce qui te captive le plus en cet instant? "
            "Est-ce la façon dont la lumière joue sur ma peau, ou l'expression dans mes yeux quand je te regarde?"
        )
        chunks = proxy.split_text(text, max_chars=220, one_sentence_per_chunk=True)
        self.assertEqual(len(chunks), 9)
        self.assertTrue(chunks[0].startswith('Oh. Arrête'))
        self.assertEqual(chunks[-1], "Est-ce la façon dont la lumière joue sur ma peau, ou l'expression dans mes yeux quand je te regarde?")


if __name__ == '__main__':
    unittest.main()
