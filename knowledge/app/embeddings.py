from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence
from itertools import pairwise
from typing import Protocol

from .config import Settings

TOKEN = re.compile(r"[\w][\w'-]{1,}", re.UNICODE)
STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "was",
    "with",
}


class Embedder(Protocol):
    name: str
    dimension: int

    def encode(self, texts: Sequence[str]) -> list[list[float]]: ...


def normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector] if norm else vector


class HashingEmbedder:
    """A deterministic, dependency-free feature hasher for tests and offline fallback.

    It is intentionally modest, but word, bigram, and character features give useful
    local similarity without making a network call or keeping a vocabulary database.
    """

    name = "hash"

    def __init__(self, dimension: int = 384):
        self.dimension = dimension

    def encode(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._encode_one(text) for text in texts]

    def _encode_one(self, text: str) -> list[float]:
        words = [word.casefold() for word in TOKEN.findall(text)]
        useful = [word for word in words if word not in STOP_WORDS]
        features: list[tuple[str, float]] = [(f"w:{word}", 1.0) for word in useful]
        features.extend(
            (f"b:{first}_{second}", 0.7) for first, second in pairwise(useful)
        )
        for word in useful:
            if 4 <= len(word) <= 32:
                padded = f"^{word}$"
                features.extend(
                    (f"c:{padded[index : index + 3]}", 0.15)
                    for index in range(len(padded) - 2)
                )
        vector = [0.0] * self.dimension
        for feature, weight in features:
            digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
            number = int.from_bytes(digest, "little")
            index = number % self.dimension
            sign = 1.0 if (number >> 63) == 0 else -1.0
            vector[index] += sign * weight
        return normalize(vector)


class SentenceTransformerEmbedder:
    name = "sentence-transformers"

    def __init__(self, model_name: str, model_revision: str, allow_download: bool):
        from sentence_transformers import SentenceTransformer

        try:
            self.model = SentenceTransformer(
                model_name,
                revision=model_revision or None,
                local_files_only=not allow_download,
            )
        except TypeError:
            # Older releases lack local_files_only. Only use them when downloading was
            # explicitly enabled; otherwise auto mode will fall back to feature hashing.
            if not allow_download:
                raise RuntimeError(
                    "installed sentence-transformers cannot enforce offline loading"
                )
            self.model = SentenceTransformer(
                model_name, revision=model_revision or None
            )
        self.dimension = int(self.model.get_sentence_embedding_dimension())

    def encode(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        embeddings = self.model.encode(
            list(texts),
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return [[float(value) for value in row] for row in embeddings]


def build_embedder(settings: Settings) -> Embedder:
    backend = settings.embedding_backend.replace("_", "-")
    if backend in {"hash", "hashing", "fallback"}:
        return HashingEmbedder(settings.embedding_dimension)
    if backend not in {"auto", "sentence-transformers", "sentence-transformer", "st"}:
        raise ValueError(f"unsupported embedding backend: {settings.embedding_backend}")
    try:
        return SentenceTransformerEmbedder(
            settings.model_name,
            settings.model_revision,
            settings.model_allow_download,
        )
    except Exception:
        if backend != "auto":
            raise
        return HashingEmbedder(settings.embedding_dimension)


def query_terms(value: str) -> set[str]:
    return {
        word.casefold()
        for word in TOKEN.findall(value)
        if word.casefold() not in STOP_WORDS
    }
